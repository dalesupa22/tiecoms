package com.tiecoms.app.platform

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.tiecoms.app.R
import com.tiecoms.app.container
import com.tiecoms.app.core.ApiException
import com.tiecoms.app.core.Attachments
import com.tiecoms.app.core.AttachmentDTO
import com.tiecoms.app.core.ForwardedInfo
import com.tiecoms.app.core.SessionStatus
import com.tiecoms.app.core.TcJson
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import java.io.File
import java.util.UUID

/**
 * Sube lo compartido y lo envía a hasta 5 conversaciones (SPEC-v4 §B). Corre en WorkManager para que una subida
 * grande siga aunque se cierre la hoja de compartir, con notificación de progreso. El trabajo se guarda en un JSON
 * (los datos de WorkManager no pasan de 10 KB) y anota qué destinos ya salieron, así un reintento no duplica.
 */
class ShareWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    @Serializable
    data class Job(
        val targets: List<String>, val files: List<Attachments.Shared> = emptyList(), val text: String = "",
        val source: String = "other", val doneTargets: List<String> = emptyList(),
    )

    companion object {
        const val KEY_JOB = "job"
        const val KEY_DONE = "done"          // archivos terminados (entre todos los destinos)
        const val KEY_TOTAL = "total"
        const val KEY_FILE = "file"          // índice del archivo que sube
        const val KEY_FRACTION = "fraction"  // 0..1 del archivo actual
        const val KEY_SENT = "sent"          // destinos enviados
        const val KEY_ERROR = "error"
        private const val CHANNEL = "uploads"
        private const val NOTIF_ID = 7301

        fun enqueue(ctx: Context, job: Job): UUID {
            val f = File(ctx.cacheDir, "share/job-" + UUID.randomUUID() + ".json")
            f.parentFile?.mkdirs(); f.writeText(TcJson.encodeToString(Job.serializer(), job))
            val req = OneTimeWorkRequestBuilder<ShareWorker>()
                .setInputData(workDataOf(KEY_JOB to f.absolutePath))
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork("share-" + req.id, ExistingWorkPolicy.KEEP, req)
            return req.id
        }

        /** Texto de la vista previa: si el origen es una app identificable (WhatsApp, correo…) se marca como reenvío. */
        fun forwardedFor(source: String): ForwardedInfo? = source.takeIf { it != "other" }?.let { ForwardedInfo(source = it) }
    }

    private val nm = ctx.getSystemService(NotificationManager::class.java)

    private fun notification(done: Int, total: Int, fraction: Float): android.app.Notification {
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, applicationContext.getString(R.string.share_upload_channel), NotificationManager.IMPORTANCE_LOW))
        val pct = if (total == 0) 0 else (((done + fraction) / total) * 100).toInt().coerceIn(0, 100)
        return NotificationCompat.Builder(applicationContext, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_tiecoms).setColor(0xFFFF7A00.toInt())
            .setContentTitle(applicationContext.getString(R.string.share_title))
            .setContentText(applicationContext.getString(R.string.share_upload_progress, (done + 1).coerceAtMost(total), total))
            .setProgress(100, pct, total == 0).setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .build()
    }

    override suspend fun getForegroundInfo(): ForegroundInfo = foreground(0, 1, 0f)

    private fun foreground(done: Int, total: Int, fraction: Float) =
        if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(NOTIF_ID, notification(done, total, fraction), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(NOTIF_ID, notification(done, total, fraction))

    override suspend fun doWork(): Result {
        val path = inputData.getString(KEY_JOB) ?: return Result.failure()
        val jobFile = File(path)
        var job = runCatching { TcJson.decodeFromString(Job.serializer(), jobFile.readText()) }.getOrNull() ?: return Result.failure()
        val c = applicationContext.container.client.value
        // Con la app cerrada, el cliente reanuda la sesión guardada.
        withTimeoutOrNull(20_000) { c.state.first { it.status == SessionStatus.READY || it.status == SessionStatus.ANONYMOUS } }
        if (c.state.value.status != SessionStatus.READY) {
            return if (c.state.value.status == SessionStatus.ANONYMOUS || runAttemptCount >= 3) fail(applicationContext.getString(R.string.share_sign_in)) else Result.retry()
        }
        val files = job.files.filter { it.path.isNotEmpty() && File(it.path).exists() && !it.tooLarge }
        val total = job.targets.size * files.size
        var done = job.doneTargets.size * files.size
        runCatching { setForeground(foreground(done, total, 0f)) }
        var lastPct = -1
        try {
            for (target in job.targets) {
                if (target in job.doneTargets) continue
                val uploaded = mutableListOf<AttachmentDTO>()
                files.forEachIndexed { i, f ->
                    uploaded += AttachmentUpload.upload(applicationContext, c, target, File(f.path), f.name, f.contentType) { sent, size ->
                        val frac = if (size > 0) sent.toFloat() / size else 0f
                        val pct = (frac * 20).toInt() // cada 5 %
                        if (pct != lastPct) {
                            lastPct = pct
                            setProgressAsync(workDataOf(KEY_DONE to done, KEY_TOTAL to total, KEY_FILE to i, KEY_FRACTION to frac, KEY_SENT to job.doneTargets.size))
                            nm.notify(NOTIF_ID, notification(done, total, frac))
                        }
                    }
                    done++; lastPct = -1
                    setProgress(workDataOf(KEY_DONE to done, KEY_TOTAL to total, KEY_FILE to i, KEY_FRACTION to 1f, KEY_SENT to job.doneTargets.size))
                }
                val cid = c.send(target, job.text, forwarded = forwardedFor(job.source), attachments = uploaded)
                    ?: throw ApiException(400, "bad_request", applicationContext.getString(R.string.share_nothing))
                // El envío sale por la cola persistente: se espera la confirmación del servidor (o su error).
                val ok = withTimeoutOrNull(60_000) {
                    while (true) {
                        val p = c.state.value.pending.firstOrNull { it.clientMessageId == cid } ?: return@withTimeoutOrNull true
                        if (p.status == "failed") return@withTimeoutOrNull false
                        delay(100)
                    }
                    @Suppress("UNREACHABLE_CODE") false
                } ?: true // sigue en la cola: saldrá cuando haya conexión
                if (ok == false) throw ApiException(400, "bad_request", c.state.value.pending.firstOrNull { it.clientMessageId == cid }?.error ?: applicationContext.getString(R.string.share_failed))
                job = job.copy(doneTargets = job.doneTargets + target)
                jobFile.writeText(TcJson.encodeToString(Job.serializer(), job))
                setProgress(workDataOf(KEY_DONE to done, KEY_TOTAL to total, KEY_FILE to files.size, KEY_FRACTION to 1f, KEY_SENT to job.doneTargets.size))
            }
        } catch (e: ApiException) {
            if (!e.permanent && runAttemptCount < 3) return Result.retry()
            return fail(e.message ?: applicationContext.getString(R.string.share_failed))
        } catch (e: java.io.IOException) {
            return if (runAttemptCount < 3) Result.retry() else fail(applicationContext.getString(R.string.share_failed))
        }
        cleanup(jobFile, files)
        return Result.success(workDataOf(KEY_SENT to job.doneTargets.size, KEY_TOTAL to total, KEY_DONE to total))
    }

    private fun fail(msg: String): Result = Result.failure(workDataOf(KEY_ERROR to msg))

    private fun cleanup(jobFile: File, files: List<Attachments.Shared>) {
        files.forEach { File(it.path).delete() }
        files.mapNotNull { File(it.path).parentFile }.distinct().forEach { d -> if (d.list()?.isEmpty() == true) d.delete() }
        jobFile.delete()
    }
}
