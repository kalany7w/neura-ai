'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { CalendarPlus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const schema = z.object({
  title: z.string().min(1).max(200),
  eventDate: z.string().min(1),
  type: z.enum(['APPLICATION', 'MAINTENANCE', 'REPAIR', 'SALE_FOLLOWUP', 'OTHER']),
});
type Input = z.infer<typeof schema>;

interface Props {
  conversationId: string;
  contactId: string;
  defaultDate?: string;
  defaultTitle?: string;
  defaultType?: Input['type'];
  trigger?: React.ReactNode;
  openExternal?: boolean;
  onOpenChange?: (o: boolean) => void;
}

export function ScheduleEventDialog({
  conversationId,
  contactId,
  defaultDate,
  defaultTitle,
  defaultType,
  trigger,
  openExternal,
  onOpenChange,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openExternal ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [submitting, setSubmitting] = useState(false);
  const qc = useQueryClient();
  const { t } = useT();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<Input>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: defaultTitle ?? '',
      eventDate: defaultDate ?? '',
      type: defaultType ?? 'OTHER',
    },
  });

  async function onSubmit(values: Input) {
    setSubmitting(true);
    try {
      await api('/api/calendar', {
        method: 'POST',
        body: JSON.stringify({
          title: values.title,
          eventDate: new Date(values.eventDate).toISOString(),
          type: values.type,
          conversationId,
          contactId,
        }),
      });
      toast.success(t('c_calendar_schedule_event_dialog.toast_success'));
      reset();
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['calendar'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('c_calendar_schedule_event_dialog.toast_error'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="h-5 w-5" /> {t('c_calendar_schedule_event_dialog.title')}
          </DialogTitle>
          <DialogDescription>
            {t('c_calendar_schedule_event_dialog.description')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="title">{t('c_calendar_schedule_event_dialog.field_title')}</Label>
            <Input id="title" {...register('title')} placeholder={t('c_calendar_schedule_event_dialog.title_placeholder')} />
            {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="eventDate">{t('c_calendar_schedule_event_dialog.field_date')}</Label>
            <Input id="eventDate" type="datetime-local" {...register('eventDate')} />
            {errors.eventDate && (
              <p className="text-xs text-destructive">{errors.eventDate.message}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label>{t('c_calendar_schedule_event_dialog.field_type')}</Label>
            <Select value={watch('type')} onValueChange={(v) => setValue('type', v as Input['type'])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="APPLICATION">{t('c_calendar_schedule_event_dialog.type_application')}</SelectItem>
                <SelectItem value="MAINTENANCE">{t('c_calendar_schedule_event_dialog.type_maintenance')}</SelectItem>
                <SelectItem value="REPAIR">{t('c_calendar_schedule_event_dialog.type_repair')}</SelectItem>
                <SelectItem value="SALE_FOLLOWUP">{t('c_calendar_schedule_event_dialog.type_sale_followup')}</SelectItem>
                <SelectItem value="OTHER">{t('c_calendar_schedule_event_dialog.type_other')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('action.cancel')}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t('c_calendar_schedule_event_dialog.submitting') : t('c_calendar_schedule_event_dialog.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
