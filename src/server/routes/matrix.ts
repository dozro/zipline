import { mxcServerServerURLHandler } from '@/server/matrix/mxc';
import { version } from '../../../package.json';
import typedPlugin from '@/server/typedPlugin';

export const PATH = '/_matrix/*';

export default typedPlugin(
  async (server) => {
    server.get('/_matrix/federation/v1/media/download/:id', mxcServerServerURLHandler);
    server.get('/_matrix/federation/v1/version', async (req, res) => {
      return res.status(200).send({
        server: {
          name: 'Zipline',
          version,
        },
      });
    });
    server.all('/_matrix/*', async (req, res) => {
      return res.status(404).send({
        errcode: 'M_UNRECOGNIZED',
        error: `This server only implements media download endpoints. You tried reaching "${req.url}".`,
      });
    });
  },
  { name: 'matrix-media-routes' },
);
