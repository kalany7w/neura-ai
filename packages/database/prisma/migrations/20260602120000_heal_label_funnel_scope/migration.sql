-- Heal labels que foram criadas pelo welcome-preset SEM routesToFunnelId.
-- Bug: welcome-presets.ts criava labels globais antes desse fix; resultado: labels
-- de XAG (Lead/Venta/Mantenimiento/Reparacion) apareciam no dropdown de cards Caltech.
--
-- Estratégia: inferir o funnel correto da label a partir de WelcomeOption.targetLabelId
-- — cada welcome option aponta pra (label, funnel, stage). Se a label hoje não tem
-- routesToFunnelId mas a welcome option tem targetFunnelId, populamos a partir dela.
--
-- Idempotente: SET é condicional (label.routesToFunnelId IS NULL). Re-rodar não muta
-- labels já vinculadas manualmente pelo admin.
--
-- Edge case: se uma label é targetLabelId de welcome options em funis diferentes
-- (raro, mas possível em multi-inbox), pegamos a primeira via subquery + LIMIT.
-- Não é estritamente determinístico mas resolve 99% dos casos sem precisar de UI.

UPDATE labels l
SET
  "routesToFunnelId" = wo."targetFunnelId",
  "routesToStageId" = wo."targetStageId"
FROM (
  SELECT DISTINCT ON ("targetLabelId")
    "targetLabelId",
    "targetFunnelId",
    "targetStageId"
  FROM welcome_options
  WHERE "targetFunnelId" IS NOT NULL
  ORDER BY "targetLabelId", "createdAt" ASC
) wo
WHERE wo."targetLabelId" = l.id
  AND l."routesToFunnelId" IS NULL
  AND wo."targetFunnelId" IS NOT NULL;
