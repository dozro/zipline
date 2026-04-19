import { ApiError } from '@/lib/api/errors';
import { config } from '@/lib/config';
import { verifyPassword } from '@/lib/crypto';
import { datasource } from '@/lib/datasource';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { fromMatrixID } from '@/lib/matrix/mxcId';
import { TimedCache } from '@/lib/timedCache';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';

const VIEW_WINDOW = 5 * 1000;
const viewsCache = new TimedCache<string, number>(VIEW_WINDOW);

type Params = {
  id: string;
};

type Querystring = {
  pw?: string;
};

type MatrixErrorResponse = {
  errcode: string;
  error: string;
};

type RequestType = FastifyRequest<{
  Params: Params;
  Querystring: Querystring;
}>;

type FileRecord = NonNullable<Awaited<ReturnType<typeof prisma.file.findFirst>>>;

const MXCIDREGEX = /^[a-zA-Z0-9._-]+$/;
const logger = log('routes').c('matrix-media');

function buildContentDisposition(file: FileRecord): string {
  if (file.originalName) {
    return `filename*=utf-8''${encodeURIComponent(file.originalName)}`;
  }

  return 'attachment;';
}

/**
 * build the body for federation responses as that must be a multipart body and not just the file itself
 *
 * @param {string} contentType the content type of the actual file
 * @param {string} contentDisposition
 * @param {Buffer} media the actual file
 * @return {*}  {{ boundary: string; body: Buffer }}
 */
function buildFederationMultipartBody(
  contentType: string,
  contentDisposition: string,
  media: Buffer,
): { boundary: string; body: Buffer } {
  const boundary = `zipline_${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`;

  const metadataPart = Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n{}\r\n`, 'utf8');

  const mediaHeaders = Buffer.from(
    `--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Disposition: ${contentDisposition}\r\n\r\n`,
    'utf8',
  );

  const closingBoundary = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([metadataPart, mediaHeaders, media, closingBoundary]);

  return { boundary, body };
}

async function readableToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

/**
 * helper function to decode matrix id, and either return the decoded id or a error response
 *
 * @param {string} rawId the id to decoded
 * @return {*}  {(string | MatrixErrorResponse)} decoded id or a error response
 */
function decodeMatrixId(rawId: string): string | MatrixErrorResponse {
  let id: string;

  try {
    id = fromMatrixID(rawId);
  } catch {
    // parsing the id somehow failed
    return {
      errcode: 'M_INVALID_PARAM',
      error: 'The ID given is not a valid MXC id',
    };
  }

  if (!MXCIDREGEX.test(id)) {
    // the id isn't in a matrix legal format
    return {
      errcode: 'M_INVALID_PARAM',
      error: 'The ID given is not a valid MXC id',
    };
  }

  return id;
}

/**
 * resolve a file record based on the file id
 *
 * @param {string} id the file id
 * @return {*}  {(Promise<FileRecord | MatrixErrorResponse>)} either the relevant FileRecord or a ErrorResponse
 */
async function resolveFileRecord(id: string): Promise<FileRecord | MatrixErrorResponse> {
  const file = await prisma.file.findFirst({
    where: {
      name: decodeURIComponent(id),
    },
  });

  if (!file) {
    return {
      errcode: 'M_NOT_FOUND',
      error: `Media with id "${id}" not found`,
    };
  }

  if (file.deletesAt && file.deletesAt <= new Date()) {
    try {
      await datasource.delete(file.name);
      await prisma.file.delete({
        where: {
          id: file.id,
        },
      });
    } catch (e) {
      logger.error('failed to delete file on expiration', { id: file.id }).error(e as Error);
    }

    return {
      errcode: 'M_FORBIDDEN',
      error: 'Media expired',
    };
  }

  return file;
}

async function verifyFilePassword(file: FileRecord, pw: string | undefined): Promise<void> {
  if (!file.password) return;
  if (!pw) throw new ApiError(3004);

  const verified = await verifyPassword(pw, file.password);
  if (!verified) throw new ApiError(3005);
}

/**
 * helper function to (kinda) enforce the max views setting
 *
 * @param {RequestType} req the request we currently handle
 * @param {FileRecord} file the record of the file we want to check
 * @return {*}  {(Promise<{ countView: () => Promise<void> } | MatrixErrorResponse>)}
 */
async function enforceMaxViews(
  req: RequestType,
  file: FileRecord,
): Promise<{ countView: () => Promise<void> } | MatrixErrorResponse> {
  const now = Date.now();
  const isView = !req.headers.range || req.headers.range.startsWith('bytes=0');
  const key = `${req.ip}-${req.headers['user-agent'] ?? 'unknown'}-${file.id}`;
  const last = viewsCache.get(key) || 0;

  const canCountView = isView && now - last > VIEW_WINDOW;
  const updatedViews = (file.views || 0) + (canCountView ? 1 : 0);

  if (file.maxViews && updatedViews > file.maxViews) {
    if (config.features.deleteOnMaxViews) {
      try {
        await datasource.delete(file.name);
        await prisma.file.delete({
          where: { id: file.id },
        });
      } catch (e) {
        logger.error('failed to delete file on max views', { id: file.id }).error(e as Error);
      }
    }

    // return a forbidden if the maximum num of downloads has been surpassed
    return {
      errcode: 'M_FORBIDDEN',
      error: 'Media has reached the maximum specified number of downloads',
    };
  }

  const countView = async () => {
    if (!canCountView) return;
    viewsCache.set(key, now);

    try {
      await prisma.file.update({
        where: { id: file.id },
        data: { views: { increment: 1 } },
      });
    } catch (e) {
      logger.error('failed to increment view counter', { id: file.id }).error(e as Error);
    }
  };

  return { countView };
}

export const mxcServerServerURLHandler = async (req: RequestType, res: FastifyReply) => {
  const decodedId = decodeMatrixId(req.params.id);
  if (typeof decodedId !== 'string') return decodedId;

  const file = await resolveFileRecord(decodedId);
  if ('errcode' in file) return file;

  await verifyFilePassword(file, req.query.pw);

  const maxViewResult = await enforceMaxViews(req, file);
  if ('errcode' in maxViewResult) return maxViewResult;

  const buf = await datasource.get(file.name ?? decodedId);
  if (!buf) {
    return {
      errcode: 'M_NOT_FOUND',
      error: `Media with id "${decodedId}" not found`,
    };
  }

  await maxViewResult.countView();

  const contentType = file.type?.startsWith('text/')
    ? `${file.type}; charset=utf-8`
    : (file.type ?? 'application/octet-stream');
  const contentDisposition = buildContentDisposition(file);
  const mediaBuffer = Buffer.isBuffer(buf) ? buf : await readableToBuffer(buf);
  /**
   * as federation (server-server) media must be served as multipart bodies
   */
  const multipart = buildFederationMultipartBody(contentType, contentDisposition, mediaBuffer);

  return res
    .type(`multipart/mixed; boundary=${multipart.boundary}`)
    .headers({
      'Content-Length': multipart.body.length,
    })
    .status(200)
    .send(multipart.body);
};
