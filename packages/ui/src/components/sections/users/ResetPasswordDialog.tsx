import * as React from 'react';
import { RiKey2Line } from '@remixicon/react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { requestJson, type UserRow } from './types';

interface ResetPasswordDialogProps {
  user: UserRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTemporaryPassword: (password: string) => void;
}

export const ResetPasswordDialog: React.FC<ResetPasswordDialogProps> = ({
  user,
  open,
  onOpenChange,
  onTemporaryPassword,
}) => {
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setPassword('');
      setConfirmation('');
    }
  }, [open]);

  const submit = async (generateTemporaryPassword: boolean) => {
    setBusy(true);
    try {
      const payload = await requestJson<{ temporaryPassword: string }>(
        `/api/admin/users/${encodeURIComponent(user.id)}/reset-password`,
        {
          method: 'POST',
          ...(generateTemporaryPassword ? {} : { body: JSON.stringify({ password }) }),
        },
      );
      if (generateTemporaryPassword) {
        onTemporaryPassword(payload.temporaryPassword);
        toast.success('Temporary password generated');
      } else {
        toast.success('Password reset');
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset password');
    } finally {
      setBusy(false);
    }
  };

  const invalidLength = password.length < 6 || password.length > 256;
  const passwordsDiffer = password !== confirmation;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reset Password</DialogTitle>
          <DialogDescription>
            Set a password for {user.email}, or generate a temporary password to share with them.
            Their active sessions will be signed out.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1 typography-meta text-foreground">
            <span>New Password</span>
            <Input
              type="password"
              autoComplete="new-password"
              minLength={6}
              maxLength={256}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="block space-y-1 typography-meta text-foreground">
            <span>Confirm Password</span>
            <Input
              type="password"
              autoComplete="new-password"
              minLength={6}
              maxLength={256}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={busy}
            />
          </label>
          {password.length > 0 && invalidLength && (
            <p className="typography-meta text-destructive">Password must be between 4 and 256 characters.</p>
          )}
          {!invalidLength && passwordsDiffer && confirmation.length > 0 && (
            <p className="typography-meta text-destructive">Passwords do not match.</p>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={() => void submit(true)} disabled={busy}>
            Generate Temporary Password
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void submit(false)} disabled={busy || invalidLength || passwordsDiffer}>
              <RiKey2Line className="h-4 w-4" /> Set Password
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
