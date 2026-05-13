import { z } from 'zod';

export const signUpSchema = z.object({
  name: z.string().min(2, 'Nome muito curto').max(80),
  email: z.string().email('Email inválido'),
  password: z
    .string()
    .min(8, 'Senha precisa ter no mínimo 8 caracteres')
    .max(128, 'Senha muito longa'),
  workspaceName: z.string().min(2, 'Nome do workspace muito curto').max(80),
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type SignInInput = z.infer<typeof signInSchema>;

export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'SUPERVISOR', 'AGENT']).default('AGENT'),
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(10),
  name: z.string().min(2).max(80).optional(),
  password: z.string().min(8).max(128).optional(),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export const switchWorkspaceSchema = z.object({
  workspaceId: z.string().min(1),
});
export type SwitchWorkspaceInput = z.infer<typeof switchWorkspaceSchema>;
