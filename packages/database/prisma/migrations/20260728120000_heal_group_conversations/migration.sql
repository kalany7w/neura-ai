-- Heal: remove contatos/conversas criados a partir de GRUPOS do WhatsApp.
-- Bug: persistInboundMessage só filtrava status@broadcast; mensagem de grupo
-- (@g.us) passava e virava contato + conversa na inbox. Fix no waworker agora
-- só aceita @s.whatsapp.net e @lid; esta migration limpa o que já entrou.
--
-- Como identificar contato-de-grupo: phoneNumber vinha de remoteJid.split('@')[0]:
--   - grupo moderno:  120363xxxxxxxxxxxx@g.us  → '+120363...' (18+ dígitos; E.164 máx 15)
--   - grupo legado:   <criador>-<timestamp>@g.us → contém '-'
-- Nenhum telefone E.164 real contém '-' nem passa de 15 dígitos, então os
-- predicados abaixo não atingem contatos legítimos (WA, LID, Telegram, webchat).
--
-- Idempotente: re-rodar não encontra mais linhas.

-- 1. Cards criados pelo auto-funil dessas conversas (cards.conversationId não tem
--    FK — precisa de delete manual antes do cascade dos contatos).
DELETE FROM cards c
USING conversations cv
JOIN contacts ct ON ct.id = cv."contactId"
WHERE c."conversationId" = cv.id
  AND (
    ct."phoneNumber" LIKE '+%-%'
    OR (ct."phoneNumber" LIKE '+120363%' AND length(ct."phoneNumber") >= 18)
  );

-- 2. Envios agendados dessas conversas (scheduled_messages.conversationId
--    também não tem FK).
DELETE FROM scheduled_messages sm
USING conversations cv
JOIN contacts ct ON ct.id = cv."contactId"
WHERE sm."conversationId" = cv.id
  AND (
    ct."phoneNumber" LIKE '+%-%'
    OR (ct."phoneNumber" LIKE '+120363%' AND length(ct."phoneNumber") >= 18)
  );

-- 3. Contatos de grupo — ON DELETE CASCADE apaga conversations, messages,
--    conversation/contact notes, labels e csat_responses ligados.
DELETE FROM contacts
WHERE "phoneNumber" LIKE '+%-%'
  OR ("phoneNumber" LIKE '+120363%' AND length("phoneNumber") >= 18);
