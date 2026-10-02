package com.tiecoms.app.core
import kotlinx.serialization.Serializable

@Serializable data class GgCalendarSlot(val startsAt: String = "", val endsAt: String = "")
@Serializable data class GgCalendarSlots(val status: String = "error", val provider: String? = null, val checkedAt: String? = null, val slots: List<GgCalendarSlot> = emptyList(), val timezone: String = "UTC", val error: String? = null)
