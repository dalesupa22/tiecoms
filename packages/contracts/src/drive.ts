import { z } from 'zod';

export type DriveVisibility = 'private' | 'shared';
export interface DriveFolderDTO { id: string; parentId: string | null; name: string; createdBy: string; createdAt: string }
export interface DriveFileDTO {
  id: string; folderId: string | null; name: string; contentType: string; size: number;
  createdBy: string; createdAt: string; updatedAt: string; visibility: DriveVisibility;
}
/** Personal, workspace and conversation trees are separate audiences. */
export interface DriveTreeDTO {
  workspaceId: string | null; conversationId: string | null;
  folders: DriveFolderDTO[]; files: DriveFileDTO[]; canManageAll: boolean; canUpload: boolean;
}

const scope = { workspaceId: z.uuid().nullable().optional(), conversationId: z.uuid().nullable().optional() };
const validScope = (v: { workspaceId?: string | null; conversationId?: string | null }) => !(v.workspaceId && v.conversationId);
const scopeError = { message: 'Elige un espacio o una conversación, no ambos' };
const driveName = z.string().trim().min(1).max(120);
export const DriveTreeQuery = z.object(scope).refine(validScope, scopeError);
export const CreateFolderInput = z.object({ ...scope, parentId: z.uuid().nullable().optional(), name: driveName }).refine(validScope, scopeError);
export const UpdateFolderInput = z.object({ name: driveName.optional(), parentId: z.uuid().nullable().optional() });
export const UpdateFileInput = z.object({ name: driveName.optional(), folderId: z.uuid().nullable().optional(), visibility: z.enum(['private', 'shared']).optional() });
export const UploadFileQuery = z.object({ ...scope, folderId: z.uuid().nullable().optional(), name: z.string().min(1).max(400), visibility: z.enum(['private', 'shared']).optional() }).refine(validScope, scopeError);
export const CreateDriveDocumentInput = z.object({
  ...scope, folderId: z.uuid().nullable().optional(), visibility: z.enum(['private', 'shared']).default('private'),
  name: driveName, format: z.enum(['docx', 'xlsx', 'pdf', 'pptx']), content: z.string().max(100_000),
}).refine(validScope, scopeError);
export type CreateDriveDocumentInput = z.input<typeof CreateDriveDocumentInput>;
