import { prisma } from './index';

async function main() {
  // eslint-disable-next-line no-console
  console.log('Seed: Fase 1 não precisa de seed (workspace é criado no signup).');
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
