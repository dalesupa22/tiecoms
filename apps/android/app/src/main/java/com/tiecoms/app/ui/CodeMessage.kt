package com.tiecoms.app.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.tiecoms.app.R
import com.tiecoms.app.core.*

@Composable
fun MessageText(text: String, mentions: List<MentionDTO>, color: Color, data: BootstrapDTO, onPerson: (String) -> Unit, modifier: Modifier = Modifier,
    interactive: Boolean = true, highlight: String? = null, maxLines: Int = Int.MAX_VALUE, onOverflow: ((Boolean) -> Unit)? = null, onColored: Boolean = false) {
    val blocks = remember(text) { Fmt.blocks(text) }
    if (blocks.isEmpty()) { InlineMessageText(text, mentions, color, data, onPerson, modifier, interactive, highlight, maxLines, onOverflow, onColored); return }
    val ctx = LocalContext.current
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        var at = 0
        fun shifted(from: Int, end: Int) = mentions.filter { it.start >= from && it.start + it.length <= end }.map { it.copy(start = it.start - from) }
        blocks.forEach { b ->
            if (b.start > at) InlineMessageText(text.substring(at, b.start), shifted(at, b.start), color, data, onPerson, interactive = interactive, highlight = highlight, maxLines = maxLines, onColored = onColored)
            val original = text.substring(b.contentStart, b.contentEnd)
            Surface(color = color.copy(alpha = .08f), shape = MaterialTheme.shapes.small) {
                Column(Modifier.padding(8.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(b.language.ifBlank { "code" }, style = MaterialTheme.typography.labelSmall, color = color)
                        if (interactive) TextButton(onClick = { copyToClipboard(ctx, original) }, modifier = Modifier.heightIn(min = 40.dp).testTag("copyCode")) { Text(stringResource(R.string.copy_code), color = color) }
                    }
                    Text(original, color = color, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium,
                        softWrap = false, modifier = Modifier.heightIn(max = 240.dp).verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).testTag("codeBlock"))
                }
            }
            at = b.end
        }
        if (at < text.length) InlineMessageText(text.substring(at), shifted(at, text.length), color, data, onPerson, interactive = interactive, highlight = highlight, maxLines = maxLines, onColored = onColored)
    }
}
