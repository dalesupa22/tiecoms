package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Aviso de «Actualización disponible» (GET /app-version): decodificación tolerante y comparación de builds. */
class AppUpdateTest {
    private fun dto(json: String) = TcJson.decodeFromString(AppVersionDTO.serializer(), json)

    @Test fun `decodifica la respuesta completa, con nulos y con campos nuevos`() {
        val v = dto("""{"platform":"android","latestVersion":"1.6.7","latestBuild":27,"minBuild":0,"url":"https://play.google.com/store/apps/details?id=com.chaggu.app","notes":"Temas del chat","futuro":1}""")
        assertEquals("1.6.7", v.latestVersion); assertEquals(27, v.latestBuild); assertEquals(0, v.minBuild); assertEquals("Temas del chat", v.notes)
        val nulls = dto("""{"platform":"android","latestVersion":"1.6.6","latestBuild":25,"minBuild":null,"url":null,"notes":null}""")
        assertEquals(0, nulls.minBuild); assertNull(nulls.url); assertNull(nulls.notes)
        // Respuesta vacía o de otro servidor: no avisa nada.
        assertEquals(AppUpdate.Status.None, AppUpdate.evaluate(26, dto("{}")))
    }

    @Test fun `franja solo si el build instalado es menor que latestBuild`() {
        val v = AppVersionDTO(latestVersion = "1.6.7", latestBuild = 27, notes = "  Novedades  ", url = "https://play/x")
        assertEquals(AppUpdate.Status.Available("1.6.7", "Novedades", "https://play/x"), AppUpdate.evaluate(26, v))
        assertEquals(AppUpdate.Status.None, AppUpdate.evaluate(27, v))
        assertEquals(AppUpdate.Status.None, AppUpdate.evaluate(28, v))
        assertEquals(AppUpdate.Status.None, AppUpdate.evaluate(26, v.copy(latestBuild = 26)))
        // Notas vacías no se muestran; sin datos (falló la red) no hay franja.
        assertNull((AppUpdate.evaluate(1, v.copy(notes = " ")) as AppUpdate.Status.Available).notes)
        assertEquals(AppUpdate.Status.None, AppUpdate.evaluate(26, null))
    }

    @Test fun `pantalla que bloquea solo con minBuild mayor que cero y el build por debajo`() {
        val v = AppVersionDTO(latestVersion = "1.7.0", latestBuild = 30, minBuild = 27)
        assertTrue(AppUpdate.evaluate(26, v) is AppUpdate.Status.Required)
        assertTrue(AppUpdate.evaluate(27, v) is AppUpdate.Status.Available)
        assertTrue(AppUpdate.evaluate(26, v.copy(minBuild = 0)) is AppUpdate.Status.Available)
        assertEquals(AppUpdate.Status.None, AppUpdate.evaluate(30, v))
    }

    @Test fun `ruta, idioma y tienda`() {
        assertEquals("/app-version?platform=android&lang=es", AppUpdate.path("es"))
        assertEquals("/app-version?platform=android&lang=en", AppUpdate.path("de"))
        assertEquals("market://details?id=com.chaggu.app", AppUpdate.marketUri("com.chaggu.app"))
        assertEquals("https://play.google.com/store/apps/details?id=com.chaggu.app", AppUpdate.webUrl("com.chaggu.app", null))
        assertEquals("https://x", AppUpdate.webUrl("com.chaggu.app", "https://x"))
    }
}
