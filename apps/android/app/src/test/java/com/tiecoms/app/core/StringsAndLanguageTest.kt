package com.tiecoms.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Locale

/** 1.6.2: «Issues» → «Subjects» en inglés; Temas (docs/TEMAS.md): la pestaña y los chips dicen «Tasks»/«Tareas». Idioma y splash. */
class StringsAndLanguageTest {
    private val res = File("src/main/res")
    /** Texto visible de cada <string>/<item> de un directorio values*, sin nombres ni comentarios. */
    private fun texts(dir: String): Map<String, String> {
        val out = linkedMapOf<String, String>()
        File(res, dir).listFiles { f -> f.name.endsWith(".xml") }!!.forEach { f ->
            val xml = f.readText().replace(Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL), "")
            Regex("<(string|item)([^>]*)>(.*?)</\\1>", RegexOption.DOT_MATCHES_ALL).findAll(xml).forEachIndexed { i, m ->
                out["${f.name}:${Regex("name=\"([^\"]+)\"").find(m.groupValues[2])?.groupValues?.get(1) ?: "item$i"}#$i"] = m.groupValues[3]
            }
        }
        return out
    }

    @Test fun `ningun Issue visible en ingles`() {
        val left = texts("values").filterValues { Regex("\\b(issue|issues)\\b", RegexOption.IGNORE_CASE).containsMatchIn(it) }
        assertTrue("Quedan «Issue» en inglés: $left", left.isEmpty())
        val en = texts("values")
        assertTrue(en.values.contains("Tasks")) // pestaña y chips (docs/TEMAS.md)
        assertTrue(en.values.contains("+%1\$d tasks"))
    }

    /** Asunto → Tarea (docs/TEMAS.md): no queda «asunto» ni «subject» visible, salvo el asunto de un correo importado. */
    @Test fun `ningun asunto ni subject visible`() {
        val es = texts("values-es").filterKeys { !it.contains(":imp_subject#") }.filterValues { Regex("\\basuntos?\\b", RegexOption.IGNORE_CASE).containsMatchIn(it) }
        assertTrue("Quedan «asunto»: $es", es.isEmpty())
        val en = texts("values").filterKeys { !it.contains(":imp_subject#") }.filterValues { Regex("\\bsubjects?\\b", RegexOption.IGNORE_CASE).containsMatchIn(it) }
        assertTrue("Quedan «subject»: $en", en.isEmpty())
        // Lo que eran «tareas» de un asunto ahora son subtareas de una tarea.
        assertTrue(texts("values-es").values.contains("Subtarea de la tarea"))
        assertTrue(texts("values").values.contains("Subtask of this task"))
    }

    @Test fun `en espanol la pestana dice Tareas`() {
        val es = texts("values-es")
        assertTrue(es.values.none { Regex("\\b(issue|issues|subject|subjects)\\b", RegexOption.IGNORE_CASE).containsMatchIn(it) })
        assertTrue(es.values.any { it == "Tareas" })
    }

    @Test fun `linea de seguridad del splash sin promesas de extremo a extremo`() {
        val es = texts("values-es").entries.first { it.key.contains(":splash_security#") }.value
        val en = texts("values").entries.first { it.key.contains(":splash_security#") }.value
        assertEquals("Conexión cifrada para proteger tu información", es)
        assertEquals("Encrypted connection to help protect your information", en)
        listOf(es, en).forEach { t -> assertTrue(Regex("extremo|end-to-end|peer|pair|p2p|segura|secure", RegexOption.IGNORE_CASE).find(t) == null) }
    }

    @Test fun `idioma de la app`() {
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromTag(""))
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromTag(null))
        assertEquals(AppLanguage.ES, AppLanguage.fromTag("es"))
        assertEquals(AppLanguage.ES, AppLanguage.fromTag("es-CO"))
        assertEquals(AppLanguage.EN, AppLanguage.fromTag("EN-us"))
        assertEquals(AppLanguage.SYSTEM, AppLanguage.fromTag("fr"))
        // Lo que se guarda vuelve igual (persistencia entre reinicios).
        AppLanguage.entries.forEach { assertEquals(it, AppLanguage.fromTag(it.tag)) }
        assertEquals("es", AppLanguage.effective(AppLanguage.SYSTEM, Locale.forLanguageTag("es-CO")))
        assertEquals("en", AppLanguage.effective(AppLanguage.SYSTEM, Locale.GERMANY))
        assertEquals("en", AppLanguage.effective(AppLanguage.EN, Locale.forLanguageTag("es-CO")))
        assertEquals("es", AppLanguage.effective(AppLanguage.ES, Locale.US))
    }
}
