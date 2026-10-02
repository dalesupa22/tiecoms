package com.tiecoms.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import com.tiecoms.app.R

/** One compact trigger; wraps the current UTF-16 selection and leaves the cursor inside empty marks. */
@Composable
fun FormatActions(text: String, selection: TextRange, onChange: (String, TextRange) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val actions = listOf(R.string.format_bold to "**", R.string.format_bullets to "- ", R.string.format_numbered to "1. ", R.string.format_inline to "`", R.string.format_block to "```\n")
    TextButton(onClick = { open = true }, modifier = Modifier.heightIn(min = 40.dp).testTag("formatButton")) { Text("Aa") }
    if (open) ActionSheet(null, actions.map { (label, mark) -> SheetItem(stringResource(label), tag = "format-$label") {
        val a = selection.min.coerceIn(0, text.length); val b = selection.max.coerceIn(a, text.length)
        val closing = if (mark == "```\n") "\n```" else if (mark == "- " || mark == "1. ") "" else mark
        val selected = text.substring(a, b)
        val result = text.take(a) + mark + selected + closing + text.substring(b)
        onChange(result, TextRange(a + mark.length, a + mark.length + selected.length))
    } }, onDismiss = { open = false })
}
