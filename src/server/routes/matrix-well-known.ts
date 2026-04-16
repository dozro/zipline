import typedPlugin from '@/server/typedPlugin';
import { config } from '@/lib/config';

export const PATH = '/.well-known/matrix/*';

function toMatrixServerName(value: string | null | undefined): string | null {
  if (!value) return null;

  const normalized = value.includes('://') ? value : `https://${value}`;

  try {
    const parsed = new URL(normalized);
    const withoutProtocol = normalized.replace(/^[a-z][a-z\d+\-.]*:\/\//i, '');
    const authority = withoutProtocol.split(/[/?#]/, 1)[0] ?? '';
    const hostWithPossiblePort = authority.split('@').pop() ?? '';
    const explicitPort = hostWithPossiblePort.match(/:(\d+)$/)?.[1];

    if (explicitPort) {
      const hostname = parsed.hostname;
      if (!hostname) return null;

      const host = hostname.includes(':') ? `[${hostname}]` : hostname;
      return `${host}:${explicitPort}`;
    }

    return parsed.host || null;
  } catch {
    return null;
  }
}

export default typedPlugin(
  async (server) => {
    server.get('/.well-known/matrix/server', async (req, res) => {
      const configuredServerName = toMatrixServerName(config.core.matrixBaseUrl);
      if (configuredServerName) {
        return res.type('application/json').send({
          'm.server': configuredServerName,
        });
      }

      const fallbackHost = toMatrixServerName(config.core.defaultDomain) || req.host;
      const fallbackPort = req.port ?? (req.protocol === 'https' ? 443 : 80);
      const serverName = fallbackHost.includes(':') ? fallbackHost : `${fallbackHost}:${fallbackPort}`;

      return res.type('application/json').send({
        'm.server': serverName,
      });
    });

    // fall back for other requests going there
    server.all('/.well-known/matrix/*', async (_req, res) => {
      return res.status(404).send({
        errcode: 'M_NOT_FOUND',
        error: 'Unknown Matrix well-known endpoint',
      });
    });
  },
  { name: 'matrix-well-known-routes' },
);
