-- Mensagem de confirmação custom enviada ao cliente após selecionar uma opção
-- do welcome flow. Texto livre (suporta placeholders {{agent.name}}, {{contact.name}})
-- pra admin adaptar ao tipo de negócio. Quando NULL, sendHandoffMessage usa um
-- fallback natural genérico que NÃO repete o label da opção crua.

ALTER TABLE welcome_options
  ADD COLUMN "confirmationText" TEXT;
