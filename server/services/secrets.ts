import { prisma } from "../db.js";
import { decryptSecret } from "../utils/crypto.js";

export async function getSecret(domain: string, envValue?: string) {
  const credential = await prisma.credential.findUnique({ where: { domain } });
  if (credential) return decryptSecret(credential.encrypted);

  return envValue || null;
}
