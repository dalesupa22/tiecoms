package com.tiecoms.app

import java.io.ByteArrayOutputStream
import java.io.File

/**
 * PDFs mínimos escritos a mano para las pruebas: páginas carta (612×792) y, si se pide, alguna con /Rotate.
 * Cada página lleva un cuadrado negro de 100×100 pt en el origen del PDF (abajo a la izquierda sin girar) y un
 * texto con su número, para ver dónde cae cada cosa al dibujarla.
 */
object PdfFixture {
    fun write(file: File, rotations: List<Int>): File {
        val out = ByteArrayOutputStream()
        val offsets = ArrayList<Int>()
        fun obj(body: String) { offsets += out.size(); out.write("${offsets.size} 0 obj\n$body\nendobj\n".toByteArray()) }
        out.write("%PDF-1.4\n".toByteArray())
        val n = rotations.size
        // 1: catálogo, 2: páginas, 3: letra, luego (página, contenido) por cada una.
        obj("<< /Type /Catalog /Pages 2 0 R >>")
        val kids = (0 until n).joinToString(" ") { "${4 + it * 2} 0 R" }
        obj("<< /Type /Pages /Kids [$kids] /Count $n >>")
        obj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
        rotations.forEachIndexed { i, rot ->
            val stream = "0 0 0 rg 0 0 100 100 re f BT /F1 36 Tf 200 400 Td (Pagina ${i + 1}) Tj ET"
            obj("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate $rot /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>")
            obj("<< /Length ${stream.length} >>\nstream\n$stream\nendstream")
        }
        val xref = out.size()
        val sb = StringBuilder("xref\n0 ${offsets.size + 1}\n0000000000 65535 f \n")
        offsets.forEach { sb.append(String.format("%010d 00000 n \n", it)) }
        sb.append("trailer\n<< /Size ${offsets.size + 1} /Root 1 0 R >>\nstartxref\n$xref\n%%EOF\n")
        out.write(sb.toString().toByteArray())
        file.writeBytes(out.toByteArray())
        return file
    }
}
