import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { AppSurfaceCard, AppSurfaceContent, AppSurfaceHeader } from '@/components/ui/app-surface';
import type { VoiceTimer } from '../../lib/voiceOverlay';
import {
  formatVoiceTimerDuration,
  getVoiceTimerRemainingMs,
} from '../../hooks/useVoiceTimers';

type TimerEditorDialogProps = {
  open: boolean;
  timer?: VoiceTimer | null;
  variant?: 'modal' | 'dock';
  isBusy: boolean;
  onClose: () => void;
  onSubmit: (payload: { title: string; durationMinutes: number; durationSeconds: number }) => void;
};

function splitDuration(durationMs: number): { minutes: number; seconds: number } {
  const totalSeconds = Math.max(1, Math.floor(durationMs / 1000));
  return {
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60,
  };
}

function TimerEditorDialogBody({
  timer,
  isBusy,
  onClose,
  onSubmit,
}: Omit<TimerEditorDialogProps, 'open' | 'variant'>): JSX.Element {
  const { t } = useTranslation();
  const defaults = useMemo(
    () => splitDuration(timer ? getVoiceTimerRemainingMs(timer) : 15 * 60 * 1000),
    [timer],
  );
  const [title, setTitle] = useState(() => timer?.title ?? '');
  const [minutes, setMinutes] = useState(() => String(defaults.minutes));
  const [seconds, setSeconds] = useState(() => String(defaults.seconds));

  const durationMinutes = Math.max(0, Math.floor(Number(minutes) || 0));
  const durationSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const durationPreview = formatVoiceTimerDuration(
    Math.max(1, durationMinutes * 60 + durationSeconds) * 1000,
  );
  const saveDisabled = isBusy || (durationMinutes === 0 && durationSeconds === 0);

  return (
    <>
      <div className="grid gap-5 md:grid-cols-2">
        <FormField
          label={t('timers.timerName')}
          hint={t('dialogs.timerEditorNameNote')}
          className="md:col-span-2"
        >
          <Input
            type="text"
            autoComplete="off"
            placeholder={t('dialogs.timerEditorNamePlaceholder')}
            value={title}
            className="h-11 border-[color:var(--input-border)] bg-[var(--input-bg)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] hover:border-[color:var(--button-secondary-border-hover)] focus-visible:border-[color:var(--input-border-focus)]"
            onChange={(event) => setTitle(event.target.value)}
            disabled={isBusy}
          />
        </FormField>

        <FormField label={t('dialogs.timerEditorMinutes')}>
          <Input
            type="number"
            min="0"
            max="1440"
            step="1"
            value={minutes}
            className="h-11 border-[color:var(--input-border)] bg-[var(--input-bg)] text-[var(--text-primary)] hover:border-[color:var(--button-secondary-border-hover)] focus-visible:border-[color:var(--input-border-focus)]"
            onChange={(event) => setMinutes(event.target.value)}
            disabled={isBusy}
          />
        </FormField>

        <FormField label={t('dialogs.timerEditorSeconds')}>
          <Input
            type="number"
            min="0"
            max="59"
            step="1"
            value={seconds}
            className="h-11 border-[color:var(--input-border)] bg-[var(--input-bg)] text-[var(--text-primary)] hover:border-[color:var(--button-secondary-border-hover)] focus-visible:border-[color:var(--input-border-focus)]"
            onChange={(event) => setSeconds(event.target.value)}
            disabled={isBusy}
          />
        </FormField>
      </div>

      <div className="rounded-xl border border-[color:var(--panel-border)] bg-[var(--panel-bg-soft)] px-4 py-3">
        <strong className="block text-sm text-[var(--text-primary)]">
          {t('dialogs.timerEditorPreviewLabel')}
        </strong>
        <span className="mt-1 block text-sm text-[var(--text-secondary)]">{durationPreview}</span>
      </div>

      <div className="flex flex-col-reverse gap-3 border-t border-[color:var(--panel-border)] bg-[var(--panel-bg-soft)] px-4 py-4 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={isBusy}
        >
          {t('dialogs.timerEditorCancel')}
        </Button>
        <Button
          type="button"
          onClick={() => onSubmit({ title: title.trim(), durationMinutes, durationSeconds })}
          disabled={saveDisabled}
        >
          {isBusy
            ? t('dialogs.timerEditorSaving')
            : timer
              ? t('dialogs.timerEditorSave')
              : t('dialogs.timerEditorCreate')}
        </Button>
      </div>
    </>
  );
}

export function TimerEditorDialog(props: TimerEditorDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const { open, timer, variant = 'modal', isBusy, onClose, onSubmit } = props;

  if (!open) {
    return null;
  }

  if (variant === 'dock') {
    return (
      <AppSurfaceCard className="w-full overflow-visible">
        <AppSurfaceHeader
          title={timer ? t('dialogs.timerEditorTitleEdit') : t('dialogs.timerEditorTitleCreate')}
          description={t('dialogs.timerEditorBody')}
        />
        <AppSurfaceContent className="space-y-5">
          <TimerEditorDialogBody
            key={timer?.id ?? 'create'}
            timer={timer}
            isBusy={isBusy}
            onClose={onClose}
            onSubmit={onSubmit}
          />
        </AppSurfaceContent>
      </AppSurfaceCard>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isBusy) {
          onClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={!isBusy}
        className="max-w-xl border border-[color:var(--panel-border)] bg-transparent text-[var(--text-primary)] shadow-none"
        style={{
          background: 'var(--panel-bg)',
          boxShadow: 'var(--panel-shadow)',
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-[var(--text-primary)]">
            {timer ? t('dialogs.timerEditorTitleEdit') : t('dialogs.timerEditorTitleCreate')}
          </DialogTitle>
          <DialogDescription className="text-[var(--text-secondary)]">
            {t('dialogs.timerEditorBody')}
          </DialogDescription>
        </DialogHeader>
        <TimerEditorDialogBody
          key={timer?.id ?? 'create'}
          timer={timer}
          isBusy={isBusy}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}
