-- Adiciona valor 'TASK' ao enum CalendarEventType. Tarefas vinculadas ao card
-- (com vencimento + responsável + descrição) reutilizam CalendarEvent — assim
-- aparecem automaticamente em /calendar e disparam recordatorio in-app o dia.
-- PG 12+ permite ALTER TYPE ADD VALUE dentro de transação.
ALTER TYPE "CalendarEventType" ADD VALUE 'TASK';
