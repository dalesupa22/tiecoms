"""SPEC-v4 (compartir, adjuntos, pestañas): textos de Android desde apps/web/src/i18n.ts (mobile-feedback).

    python3 tools/strings_v4.py [ruta/a/i18n.ts]

Igual que strings_v3.py: con clave web se usa el texto de la web. Si la web todavía no tiene la clave, se usa el respaldo
(y se avisa); al regenerar cuando la clave exista, gana la web. Parámetros: {n} → %d, el resto → %s, en el orden dado.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from strings_v3 import DEFAULT_I18N, load, convert, esc, HERE  # noqa: E402

S = [
# Pestañas de Inicio (home.tab.*)
("home_tab_all", "home.tab.all", [], "", ""),
("home_tab_unread", "home.tab.unread", [], "", ""),
("home_tab_issues", "home.tab.issues", [], "", ""),
("home_tab_chats", "home.tab.chats", [], "", ""),
("home_tab_sides", "home.tab.sides", [], "", ""),
("home_tab_caught_up", "home.empty.unread", [], "", ""),
("home_empty_issues", "home.empty.issues", [], "", ""),
("home_empty_chats", "home.empty.chats", [], "", ""),
("home_empty_sides", "home.empty.sides", [], "", ""),
("home_empty_all", "home.empty.all", [], "", ""),
("home_filters", "home.filters", [], "", ""),
("common_you_short", "common.youShort", [], "", ""),
# Adjuntos (att.*): las etiquetas de vista previa ya traen el emoji.
("att_photo", "att.photo", [], "", ""),
("att_photos", "att.photos", ["n"], "", ""),
("att_video", "att.video", [], "", ""),
("att_videos", "att.videos", ["n"], "", ""),
("att_media", "att.media", ["n"], "", ""),
("att_file", "att.file", ["name"], "", ""),
("att_files", "att.files", ["n"], "", ""),
("att_attach", "att.add", [], "", ""),
("att_photos_pick", "att.fromPhotos", [], "", ""),
("att_camera", "att.fromCamera", [], "", ""),
("att_files_pick", "att.fromFiles", [], "", ""),
("att_remove", "att.remove", [], "", ""),
("att_retry", "att.retry", [], "", ""),
("att_too_large", "att.tooBig", ["name"], "", ""),
("att_too_many", "att.max", [], "", ""),
("att_uploading", "att.uploading", [], "", ""),
("att_uploading_n", "att.uploadingN", ["i", "n"], "", ""),
("att_upload_failed", "att.failed", ["name"], "", ""),
("att_download", "att.download", [], "", ""),
("att_open", "att.open", [], "", ""),
("att_more", "att.more", ["n"], "", ""),
("att_viewer", "att.viewer", [], "", ""),
("att_prev", "att.prev", [], "", ""),
("att_next", "att.next", [], "", ""),
("att_unavailable", "att.unavailable", [], "", ""),
("att_out_of_history", "att.outOfHistory", [], "", ""),
("att_count", "att.count", ["i", "n"], "", ""),
("att_open_with", None, [], "Abrir con…", "Open with…"),                                   # solo Android: selector del sistema
("att_downloading", None, [], "Descargando…", "Downloading…"),                              # solo Android
("att_no_app", None, [], "No hay una app para abrir este archivo.", "No app can open this file."),  # solo Android
# Compartir hacia Chaggu (share.*)
("share_header", "share.header", [], "", ""),
("share_add_message", "share.addMessage", [], "", ""),
("share_send", "share.send", [], "", ""),
("share_send_to", "share.sendTo", ["n"], "", ""),
("share_pick", "share.pick", [], "", ""),
("share_sign_in", "share.signIn", [], "", ""),
("share_open_app", "share.openApp", [], "", ""),
("share_sent_one", "share.sentOne", [], "", ""),
("share_sent", "share.sentMany", ["n"], "", ""),
("share_progress", "share.progress", ["i", "n"], "", ""),
("share_recent", "share.recent", [], "", ""),
("share_items", "share.items", ["n"], "", ""),
("share_item", "share.item", [], "", ""),
("share_failed", "share.failed", [], "", ""),
("share_nothing", "share.empty", [], "", ""),
("share_max_targets", "share.max5", [], "", ""),
# §D Nuevo chat: persona/grupal o grupo en un espacio, y orden por no leídos
("chat_mode_person", "chat.mode.person", [], "", ""),
("chat_mode_space", "chat.mode.space", [], "", ""),
("chat_pick_space", "chat.pickSpace", [], "", ""),
("chat_group_name_label", "chat.groupName", [], "", ""),
("chat_internal_only", "chat.internalOnly", [], "", ""),
("chat_internal_hint", "chat.internalHint", [], "", ""),
("chat_directive", "chat.directive", [], "", ""),
("chat_no_spaces", "chat.noSpaces", [], "", ""),
("space_create_group", "chat.createSpaceGroup", [], "", ""),
("space_members", "chat.spaceMembers", [], "", ""),
("space_search", "chat.searchSpace", [], "", ""),
("space_create_space", "dlg.createSpace", [], "", ""),
("home_sort_hint", "home.sortHint", [], "", ""),
# §E Aviso de reunión 10 min antes
("cal_soon", "cal.soon", ["n", "title"], "", ""),
("cal_chats_section", "cal.chatsSection", [], "", ""),
("issue_chats_section", "issue.chatsSection", [], "", ""),
("cal_channel_soon", "cal.channelSoon", [], "", ""),
("cal_channel_soon_desc", "cal.channelSoonDesc", [], "", ""),
# §F Notas de voz (voice.*)
("voice_note", "voice.note", [], "", ""),
("voice_preview", "voice.preview", ["d"], "", ""),
("voice_record", "voice.hold", [], "", ""),
("voice_slide_cancel", "voice.slideCancel", [], "", ""),
("voice_slide_lock", "voice.slideLock", [], "", ""),
("voice_recording", "voice.recording", [], "", ""),
("voice_locked", "voice.locked", [], "", ""),
("voice_paused", "voice.paused", [], "En pausa", "Paused"),
("voice_send", "voice.send", [], "", ""),
("voice_delete", "voice.discard", [], "", ""),
("voice_too_short", "voice.tooShort", [], "", ""),
("voice_too_long", "voice.tooLong", [], "", ""),
("voice_play", "voice.play", [], "", ""),
("voice_pause", "voice.pause", [], "", ""),
("voice_speed", "voice.speed", [], "", ""),
("voice_show_transcript", "voice.showTranscript", [], "", ""),
("voice_hide_transcript", "voice.hideTranscript", [], "", ""),
("voice_transcribing", "voice.transcribing", [], "", ""),
("voice_failed", "voice.failed", [], "", ""),
("voice_retry", "voice.retry", [], "", ""),
("voice_copy", "voice.copy", [], "", ""),
("voice_copied", "voice.copied", [], "", ""),
("voice_summary", "voice.summary", [], "", ""),
("voice_create_issue", "voice.createIssue", ["title"], "", ""),
("voice_unheard", "voice.unheard", [], "", ""),
("voice_cancelled", "voice.cancelled", [], "", ""),
("voice_uploading", "voice.uploading", [], "", ""),
("voice_mic_title", None, [], "Micrófono", "Microphone"),                                     # solo Android: título del diálogo previo
("voice_mic_body", "voice.micPermission", [], "", ""),
("voice_mic_allow", None, [], "Permitir", "Allow"),                                          # solo Android
("voice_mic_denied", "voice.micDenied", [], "", ""),
# Compartir: textos solo de Android (subida en segundo plano con WorkManager)
("share_dropped", "share.dropped", ["n"], "Se enviarán 10; quedan fuera {n}.", "10 will be sent; {n} left out."),
("share_bg", "share.background", [], "Sigue subiendo en segundo plano.", "It keeps uploading in the background."),
("share_upload_channel", "share.uploadChannel", [], "Subidas", "Uploads"),
("share_upload_progress", "share.uploadProgress", ["i", "n"], "Subiendo {i} de {n}", "Uploading {i} of {n}"),
]

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_I18N
    es, en = load(path)
    rows, fallback = [], []
    for name, key, params, fes, fen in S:
        if key and key in es and key in en:
            rows.append((name, convert(es[key], params, name), convert(en[key], params, name)))
        else:
            fallback.append(key or name)
            rows.append((name, convert(fes, params, name), convert(fen, params, name)))
    R = os.path.join(HERE, "..", "app", "src", "main", "res")
    for d, idx in (("values", 2), ("values-es", 1)):
        out = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Generado con tools/strings_v4.py desde apps/web/src/i18n.ts (SPEC-v4). -->', '<resources>']
        out += [f'    <string name="{r[0]}">{esc(r[idx])}</string>' for r in rows]
        out.append('</resources>')
        open(os.path.join(R, d, "strings_v4.xml"), "w", encoding="utf-8").write("\n".join(out) + "\n")
    print(f"{len(rows)} textos; {len(rows) - len(fallback)} de la web; respaldo (aún no en la web): {len(fallback)}")
