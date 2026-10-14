import { AI_PROVIDERS } from "@/shared/constants/providers";
import {
  buildProviderConnectionStatus,
  maskSensitiveAccountLabel,
  sanitizeProviderError,
} from "@/lib/providerConnectionStatus";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

export function toProviderConnectionResponse(connection, options = {}) {
  const { apiKey, accessToken, refreshToken, idToken, ...safe } = connection;
  safe.name = maskSensitiveAccountLabel(safe.name);
  safe.displayName = maskSensitiveAccountLabel(safe.displayName);
  safe.lastError = sanitizeProviderError(safe.lastError);
  safe.health = buildProviderConnectionStatus(connection, options);

  if (!usesAwsCredentialForm(connection.provider) || !connection.providerSpecificData) {
    return safe;
  }

  const { sessionToken, ...providerSpecificData } = connection.providerSpecificData;
  return { ...safe, providerSpecificData };
}
