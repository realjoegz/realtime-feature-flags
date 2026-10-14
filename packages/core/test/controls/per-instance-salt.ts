// P1 control: a salt drawn when the module loads and mixed into every bucket.
// Each module instance, and so each process, assigns users differently.

import { randomBytes } from 'node:crypto';
import { BUCKET_COUNT, bucketInput, murmur3X86_32Utf8 } from '../../src/index.ts';
import { evaluatorWith } from './broken-evaluators.ts';

const instanceSalt = randomBytes(8).toString('hex');

export const evaluate = evaluatorWith({
  bucket: (flag, userKey) =>
    murmur3X86_32Utf8(bucketInput(flag.key, flag.salt + instanceSalt, userKey), 0) % BUCKET_COUNT,
});
