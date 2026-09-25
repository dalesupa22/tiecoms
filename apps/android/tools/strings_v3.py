"""SPEC-v3: textos nuevos de Android tomados de la web (apps/web/src/i18n.ts de mobile-feedback, 86341e1).

    python3 tools/strings_v3.py [ruta/a/i18n.ts]

Cada fila: (nombre Android, clave web, parámetros en orden, es de respaldo, en de respaldo).
Con clave web se usa SIEMPRE el texto de la web ({n} → %1$d, {name} → %1$s…); el respaldo solo aplica a
las pocas claves que la web no tiene (marcadas «solo Android»).
"""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_I18N = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "tiecoms-feedback", "apps", "web", "src", "i18n.ts"))

S = [
# Jerarquía de Inicio
("side_companies", "side.companies", [], "", ""),
("side_chats", "side.directs", [], "", ""),
("side_new_space", "side.newSpace", [], "", ""),
("dlg_new_space", "dlg.newSpace", [], "", ""),
("dlg_new_space_body", "dlg.newSpaceBody", [], "", ""),
("dlg_space_name", "dlg.spaceName", [], "", ""),
("dlg_space_name_ph", "dlg.spaceNamePh", [], "", ""),
("dlg_department", "dlg.department", [], "", ""),
("dlg_department_ph", "dlg.departmentPh", [], "", ""),
("dlg_create_space", "dlg.createSpace", [], "", ""),
("side_empty", "side.empty", [], "", ""),
("common_no_company", "common.noCompany", [], "", ""),
("expand", "home.expand", [], "", ""),
("collapse", "home.collapse", [], "", ""),
("home_unread_in", "home.unreadIn", ["n"], "", ""),
("issues_count_one", "issue.chipOne", [], "", ""),
("issues_count", "issue.chipMany", ["n"], "", ""),
("issues_open_bar", "issue.openBar", ["n"], "", ""),
("issue_all", "issue.all", [], "", ""),
("issue_comment_ph3", "issue.commentPh", [], "", ""),
("issue_no_comments", "issue.noComments", [], "", ""),
("issue_commented", "issue.commented", [], "", ""),
("issue_comment_sent", "issue.commentSent", [], "", ""),
("common_saving", "common.saving", [], "", ""),
("common_saved", "common.saved", [], "", ""),
("system_message", None, [], "Mensaje del sistema", "System message"),                      # solo Android: JSON de sistema ilegible
("issue_in_conversation", None, [], "Asuntos de «%1$s»", "Issues in “%1$s”"),                # solo Android: lista filtrada desde el chip
("details_short", None, [], "Detalles", "Details"),                                           # solo Android: menú de la lista
("notif_you", None, [], "Tú", "You"),                                                          # solo Android: MessagingStyle (common.you es «(tú)»)
# Responder en privado
("menu_reply_private", "preply.action", [], "", ""),
("reply_private_to", "preply.bar", ["name"], "", ""),
("reply_private_cancel", "preply.cancel", [], "", ""),
("reply_private_label", "preply.you", ["excerpt"], "", ""),
("reply_private_label_them", "preply.other", ["name", "excerpt"], "", ""),
("reply_private_in", "preply.in", ["name"], "", ""),
("reply_private_open", "preply.open", [], "", ""),
("reply_private_unreachable", "preply.unreachable", [], "", ""),
("person_send_message", "people.sendMessage", [], "", ""),
("chat_new_button", "chat.newButton", [], "", ""),
# Conversaciones laterales
("menu_ask_side", "side.ask", [], "", ""),
("side_title", "side.title", [], "", ""),
("side_kind", "lin.kind.side", [], "", ""),
("side_chip", "side.chipN", ["n"], "", ""),
("side_pick", "side.pick", [], "", ""),
("side_hint", "side.body", [], "", ""),
("side_search", "side.search", [], "", ""),
("side_in_chat", "side.inChat", [], "", ""),
("side_colleagues", "side.colleagues", [], "", ""),
("side_question", "side.question", [], "", ""),
("side_question_ph", "side.questionPh", [], "", ""),
("side_start", "side.create", [], "", ""),
("side_outsider", "side.why.outsider", [], "", ""),
("side_blocked", "side.why.blocked", [], "", ""),
("side_private", "side.private", [], "", ""),
("side_return", "side.return", [], "", ""),
("side_anchor", "side.anchor", [], "", ""),
("side_open_full", "side.openFull", [], "", ""),
("side_close", "side.close", [], "", ""),
("err_side_outsider", "err.side_outsider", [], "", ""),
("err_blocked_user", "err.blocked_user", [], "", ""),
("sys_side_started", "sys.side.started", ["authorName", "excerpt"], "", ""),
("sys_side_started_in", "sys.side.startedIn", ["authorName", "parentName", "excerpt"], "", ""),
# Fotos
("photo_choose", "photo.choose", [], "", ""),
("photo_gallery", "photo.fromGallery", [], "", ""),
("photo_camera", "photo.fromCamera", [], "", ""),
("photo_files", "photo.fromFiles", [], "", ""),
("photo_crop_title", "photo.cropTitle", [], "", ""),
("photo_crop_group_title", "photo.cropGroupTitle", [], "", ""),
("photo_crop_hint", "photo.cropHint", [], "", ""),
("photo_saving", "photo.saving", [], "", ""),
("photo_saved", "photo.saved", [], "", ""),
("photo_failed", "photo.failed", [], "", ""),
("photo_compressed", "photo.compressed", [], "", ""),
("photo_remove_confirm", "photo.removeConfirm", [], "", ""),
("photo_removed", "photo.removed", [], "", ""),
("photo_invalid", "photo.invalid", [], "", ""),
("photo_tap_to_change", "photo.tapToChange", [], "", ""),
("group_photo", "group.photo", [], "", ""),
("group_add_photo", "group.addPhoto", [], "", ""),
("group_change_photo", "group.changePhoto", [], "", ""),
("group_remove_photo", "group.removePhoto", [], "", ""),
("group_remove_confirm", "group.removeConfirm", [], "", ""),
("group_photo_saved", "group.photoSaved", [], "", ""),
("group_photo_removed", "group.photoRemoved", [], "", ""),
("group_photo_only_admins", "group.photoOnlyAdmins", [], "", ""),
("sys_group_photo_changed", "sys.group.photo_changed", [], "", ""),
("sys_group_photo_removed", "sys.group.photo_removed", [], "", ""),
# Push
("push_why_title", "push.primerTitle", [], "", ""),
("push_why_body", "push.primerBody", [], "", ""),
("push_allow", "push.enable", [], "", ""),
("push_later", "push.later", [], "", ""),
("push_denied", "push.denied", [], "", ""),
("push_unavailable", "push.unavailable", [], "", ""),
("notif_reply", "push.reply", [], "", ""),
("notif_reply_hint", "push.replyPh", [], "", ""),
("notif_reply_failed", "push.replyFailed", [], "", ""),
("notif_mark_read", "push.markRead", [], "", ""),
("notif_new_message", "push.newMessage", [], "", ""),
("notif_channel_messages", "push.channelMessages", [], "", ""),
("notif_channel_messages_desc", "push.channelMessagesDesc", [], "", ""),
("notif_channel_reminders", "push.channelReminders", [], "", ""),
("notif_channel_reminders_desc", "push.channelRemindersDesc", [], "", ""),
("notif_channel_events", "push.channelEvents", [], "", ""),
("notif_channel_events_desc", "push.channelEventsDesc", [], "", ""),
]


def load(path):
    """El archivo tiene dos diccionarios, es primero y en después: la segunda aparición de una clave es la inglesa."""
    src = open(path, encoding="utf-8").read()
    es, en = {}, {}
    for k, v in re.findall(r"'([a-zA-Z0-9_.]+)':\s*'((?:[^'\\]|\\.)*)'", src):
        v = v.replace("\\'", "'")
        if k not in es: es[k] = v
        elif k not in en: en[k] = v
    return es, en


def convert(text, params, name):
    out = text
    for i, p in enumerate(params, 1):
        fmt = "d" if p == "n" else "s"
        if "{" + p + "}" not in out: raise SystemExit(f"{name}: falta {{{p}}} en «{text}»")
        out = out.replace("{" + p + "}", f"%{i}${fmt}")
    left = re.findall(r"\{[a-zA-Z]+\}", out)
    if left: raise SystemExit(f"{name}: parámetros sin mapear {left} en «{text}»")
    return out


def esc(v):
    return v.replace("&", "&amp;").replace("<", "&lt;").replace("'", "\\'").replace('"', '\\"')


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_I18N
    es, en = load(path)
    names = [r[0] for r in S]; assert len(names) == len(set(names))
    rows = []
    for name, key, params, fes, fen in S:
        if key:
            if key not in es or key not in en: raise SystemExit(f"{name}: la web no tiene «{key}»")
            rows.append((name, convert(es[key], params, name), convert(en[key], params, name)))
        else:
            rows.append((name, fes, fen))
    R = os.path.join(HERE, "..", "app", "src", "main", "res")
    for d, idx in (("values", 2), ("values-es", 1)):
        out = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Generado con tools/strings_v3.py desde apps/web/src/i18n.ts (SPEC-v3). -->', '<resources>']
        out += [f'    <string name="{r[0]}">{esc(r[idx])}</string>' for r in rows]
        out.append('</resources>')
        open(os.path.join(R, d, "strings_v3.xml"), "w", encoding="utf-8").write("\n".join(out) + "\n")
    print(f"{len(rows)} textos ({sum(1 for r in S if r[1])} de la web)")
