package com.tiecoms.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit

/** Opt-in real FCM provisioning; never logs the installation's token. */
@RunWith(AndroidJUnit4::class)
class FcmProvisioningTest {
    @Test fun provisionRealFirebaseInstallation() {
        assumeTrue("Real FCM requires explicit opt-in", InstrumentationRegistry.getArguments().getString("realFcm") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val firebase = FirebaseApp.getInstance()
        assertEquals("tiecoms", firebase.options.projectId)
        assertFalse(firebase.options.gcmSenderId.isNullOrBlank())
        val token = Tasks.await(FirebaseMessaging.getInstance().token, 45, TimeUnit.SECONDS)
        assertTrue("FCM must issue an installation token", token.isNotBlank())
        File(context.filesDir, "fcm-test-token").writeText(token)
    }
}
