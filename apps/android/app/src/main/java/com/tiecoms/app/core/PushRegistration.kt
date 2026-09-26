package com.tiecoms.app.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Keep a new-session/token trigger queued if another registration is still in flight. */
internal class PushRegistrationCoordinator {
    private val registration = Mutex()

    suspend fun synchronize(
        allowed: () -> Boolean,
        attempt: suspend () -> Unit,
        wait: suspend (Long) -> Unit = { delay(it) },
        reportFailure: () -> Unit = {},
    ) = registration.withLock {
        retryPushRegistration(allowed, attempt, wait, reportFailure)
    }
}

/** A short retry burst. A later session, foreground or network event can start another. */
internal suspend fun retryPushRegistration(
    allowed: () -> Boolean,
    attempt: suspend () -> Unit,
    wait: suspend (Long) -> Unit = { delay(it) },
    reportFailure: () -> Unit = {},
) {
    repeat(3) { index ->
        if (!allowed()) return
        try {
            attempt()
            return
        } catch (_: TimeoutCancellationException) {
            reportFailure()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            reportFailure()
        }
        if (index < 2) wait(if (index == 0) 1_000 else 4_000)
    }
}
