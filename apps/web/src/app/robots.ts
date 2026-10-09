import type { MetadataRoute } from 'next';

// Rastreamento LIBERADO de propósito. Quem tira o app do Google é o noindex
// (meta robots do layout raiz + header X-Robots-Tag do next.config), e o Google só
// enxerga esse noindex se puder buscar a página. Um Disallow aqui impediria a
// leitura e deixaria congeladas no índice as URLs que já foram indexadas.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
  };
}
