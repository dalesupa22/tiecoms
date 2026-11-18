package com.tiecoms.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tiecoms.app.core.ChatSlice
import com.tiecoms.app.core.ClientState
import com.tiecoms.app.core.TieComsClient
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map

/**
 * CH035 (tanda 2): leer UNA parte del estado. Quien llama solo se recompone cuando cambia el resultado de [selector]
 * (comparado con `==`), no con cada emisión del estado global. [keys] = lo que el selector captura (un id, por ejemplo).
 * El selector corre en cada emisión: debe ser barato (leer un campo, una entrada de un mapa).
 */
@Composable
fun <T> TieComsClient.select(vararg keys: Any?, selector: (ClientState) -> T): State<T> = key(this, *keys) {
    val flow = remember { state.map(selector).distinctUntilChanged() }
    flow.collectAsStateWithLifecycle(remember { selector(state.value) })
}

/** Igual que [select] pero compara por identidad: para listas y mapas grandes que el cliente reemplaza al cambiar. */
@Composable
fun <T> TieComsClient.selectRef(vararg keys: Any?, selector: (ClientState) -> T): State<T> = key(this, *keys) {
    val flow = remember { state.map(selector).distinctUntilChanged { a, b -> a === b } }
    flow.collectAsStateWithLifecycle(remember { selector(state.value) })
}

/** La porción del estado que ve el chat [id] (ver [ChatSlice]): no cambia con lo que pasa en otros chats. */
@Composable
fun TieComsClient.chatState(id: String): State<ClientState> = sliceState(id) { prev, st -> ChatSlice.next(prev, st, id) }

/** La porción del estado que leen las listas de Grupos y DMs (ver [ChatSlice.lists]). */
@Composable
fun TieComsClient.listsState(): State<ClientState> = sliceState { prev, st -> ChatSlice.lists(prev, st) }

/** [next] devuelve la porción anterior (misma instancia) cuando no cambió nada pertinente: entonces no se emite. */
@Composable
private fun TieComsClient.sliceState(vararg keys: Any?, next: (ClientState?, ClientState) -> ClientState): State<ClientState> = key(this, *keys) {
    val initial = remember { next(null, state.value) }
    // La última porción vive fuera del flujo: al volver de segundo plano la colección se reinicia y sigue desde ella.
    val last = remember { arrayOf(initial) }
    val flow = remember {
        flow {
            state.collect { st ->
                val slice = next(last[0], st)
                if (slice !== last[0]) { last[0] = slice; emit(slice) }
            }
        }
    }
    flow.collectAsStateWithLifecycle(initial)
}
