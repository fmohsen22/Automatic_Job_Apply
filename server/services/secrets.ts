import { prisma } from "../db.js";
import { decryptSecret } from "../utils/crypto.js";

export async function getSecret(domain: string, envValue?: string) {
  if (envValue) return envValue;

  const credential = await prisma.credential.findUnique({ where: { domain } });
  if (!credential) return null;

  return decryptSecret(credential.encrypted);
}
