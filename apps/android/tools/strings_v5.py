"""Sidechats (SPEC-v4 §G) y menciones con @ (§H): textos de Android desde apps/web/src/i18n.ts (mobile-feedback).

    python3 tools/strings_v5.py [ruta/a/i18n.ts]
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from strings_v3 import DEFAULT_I18N, load, convert, esc, HERE  # noqa: E402

S = [
# §G Sidechats
("side_replies", "side.replies", ["n"], "", ""),
("side_reply_one", "side.replyOne", [], "", ""),
("side_thread", "side.thread", ["n"], "", ""),
("side_chip_one", "side.chip", [], "", ""),
("side_returned_chip", "side.returnedChip", [], "", ""),
("side_from_sidechat", "side.fromSidechat", [], "", ""),
("side_private_n", "side.privateN", ["n"], "", ""),
("side_placeholder", "side.placeholder", ["name"], "", ""),
("side_placeholder_many", "side.placeholderMany", [], "", ""),
("side_quick_check", "side.quick.check", [], "", ""),
("side_quick_ask", "side.quick.ask", [], "No sé, pregúntale a…", "I don’t know, ask…"),        # la web aún no tiene la versión en inglés
("side_quick_later", "side.quick.later", [], "Te respondo en un rato", "I’ll get back to you soon"),
("side_empty_chat", "side.emptyChat", [], "", ""),
("side_see_in_chat", "side.seeInChat", [], "", ""),
("side_publish", "side.publish", [], "", ""),
("side_preview_in_group", "side.previewInGroup", [], "", ""),
("side_suggested", "side.suggested", [], "", ""),
("side_suggested_fallback", "side.suggestedFallback", [], "", ""),
("side_suggesting", "side.suggesting", [], "", ""),
("side_add_person", "side.addPerson", [], "", ""),
("side_leave", "side.leave", [], "", ""),
("side_minimize", "side.minimize", [], "", ""),
("side_pick_people", "side.pickPeople", [], "", ""),
("side_suggestions", "side.suggestions", [], "", ""),
("side_enter_sends", "side.enterSends", [], "", ""),
("side_default_name", "side.defaultName", ["excerpt"], "", ""),
("side_return_edit", "side.returnEdit", [], "", ""),
("side_return_body", "side.returnBody", ["name"], "", ""),
("side_returned", "side.returned", [], "", ""),
("side_list", "side.list", [], "", ""),
("side_selected", "side.selected", ["n"], "", ""),
("side_selected_one", "side.selectedOne", [], "", ""),
("side_why_blocked", "side.why.blocked", [], "", ""),
("side_why_history", "side.why.history", [], "", ""),
("side_from_message", "side.fromMessage", ["name"], "", ""),
("side_notif_title", None, ["name"], "💬 Sidechat de {name}", "💬 Sidechat from {name}"),         # solo Android: notificación local
# §H Menciones
("mention_all", "mention.all", [], "", ""),
("mention_all_hint", "mention.allHint", [], "", ""),
("mention_you_mentioned", "mention.youMentioned", [], "", ""),
("mention_mentioned_you", "mention.mentionedYou", ["name"], "", ""),
("mention_inbox", "mention.inbox", [], "", ""),
("mention_empty", "mention.empty", [], "", ""),
("mention_tab", "home.tab.mentions", [], "", ""),
("mention_badge", "mention.badge", [], "", ""),
("mention_not_in_chat", "mention.notInChat", ["name"], "", ""),
("mention_add_to_chat", "mention.addToChat", [], "", ""),
("mention_ask_side", "mention.askSide", [], "", ""),
("mention_dropped", "mention.dropped", ["names"], "", ""),
("mention_picker", "mention.picker", [], "", ""),
("mention_no_match", "mention.noMatch", [], "", ""),
("mention_load_more", "mention.loadMore", [], "", ""),
("mention_in_conv", "mention.inConv", ["name"], "", ""),
("mention_all_label", "mention.allLabel", [], "", ""),
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
        out = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Generado con tools/strings_v5.py desde apps/web/src/i18n.ts (SPEC-v4 §G, §H). -->', '<resources>']
        out += [f'    <string name="{r[0]}">{esc(r[idx])}</string>' for r in rows]
        out.append('</resources>')
        open(os.path.join(R, d, "strings_v5.xml"), "w", encoding="utf-8").write("\n".join(out) + "\n")
    print(f"{len(rows)} textos; {len(rows) - len(fallback)} de la web; respaldo: {len(fallback)}")
