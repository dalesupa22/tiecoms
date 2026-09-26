package com.tiecoms.app.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class PushRegistrationTest {
    @Test fun `trigger during in-flight registration queues latest session and token`() = runBlocking {
        val coordinator = PushRegistrationCoordinator()
        val started = CompletableDeferred<Unit>()
        val finishFirst = CompletableDeferred<Unit>()
        var session = "session-A"
        var token = "token-A"
        val sent = mutableListOf<Pair<String, String>>()
        val attempt: suspend () -> Unit = {
            val current = session to token
            if (current.first == "session-A") {
                started.complete(Unit)
                finishFirst.await()
            }
            sent += current
        }
        val first = launch { coordinator.synchronize(allowed = { true }, attempt = attempt) }
        started.await()
        session = "session-B"
        token = "token-B"
        val next = launch { coordinator.synchronize(allowed = { true }, attempt = attempt) }
        yield()
        finishFirst.complete(Unit)
        first.join()
        next.join()
        assertEquals(listOf("session-A" to "token-A", "session-B" to "token-B"), sent)
    }

    @Test fun `transient registration failures recover with bounded delays`() = runBlocking {
        var attempts = 0
        val delays = mutableListOf<Long>()
        retryPushRegistration(allowed = { true }, attempt = {
            if (++attempts < 3) throw IOException("offline")
        }, wait = { delays += it })
        assertEquals(3, attempts)
        assertEquals(listOf(1_000L, 4_000L), delays)
    }

    @Test fun `persistent failure stops after three attempts`() = runBlocking {
        var attempts = 0
        retryPushRegistration(allowed = { true }, attempt = {
            attempts++
            throw IOException("offline")
        }, wait = {})
        assertEquals(3, attempts)
    }

    @Test fun `logout or notification opt out stops queued retries`() = runBlocking {
        var allowed = true
        var attempts = 0
        retryPushRegistration(allowed = { allowed }, attempt = {
            attempts++
            throw IOException("offline")
        }, wait = { allowed = false })
        assertEquals(1, attempts)
    }

    @Test fun `no registration before session readiness or permission`() = runBlocking {
        retryPushRegistration(allowed = { false }, attempt = { fail("Must not register") }, wait = { fail("Must not wait") })
    }

    @Test fun `cancelled caller does not retry`() = runBlocking {
        var attempts = 0
        try {
            retryPushRegistration(allowed = { true }, attempt = {
                attempts++
                throw CancellationException("stopped")
            }, wait = { fail("Must not wait") })
            fail("Cancellation must propagate")
        } catch (_: CancellationException) {
            assertEquals(1, attempts)
        }
    }
}
