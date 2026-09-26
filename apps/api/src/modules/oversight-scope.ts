/**
 * Grupos que un administrador de la empresa puede ver: los grupos compartidos (y los internos de su
 * propia empresa) de espacios donde su empresa participa y donde hay al menos una persona de su empresa.
 * Los internos de otras empresas, los directos y los chats nunca entran.
 */
export const OVERSIGHT_SCOPE = `
  c.archived_at IS NULL AND c.kind IN ('group','internal') AND (c.kind = 'group' OR c.internal_org_id = $ORG)
  AND EXISTS (SELECT 1 FROM workspace_organizations wo WHERE wo.workspace_id = c.workspace_id AND wo.org_id = $ORG AND wo.left_at IS NULL)
  AND EXISTS (SELECT 1 FROM conversation_memberships cm JOIN organization_memberships om ON om.user_id = cm.user_id AND om.org_id = $ORG
               WHERE cm.conversation_id = c.id AND cm.removed_at IS NULL)`;
