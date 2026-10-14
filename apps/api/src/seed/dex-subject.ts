// The "sub" that Dex puts in its tokens for a user of a connector: the protobuf
// message IDTokenSubject { string user_id = 1; string conn_id = 2; } in base64url
// without padding (server/internal/codec.go in Dex). Static users of Dex's password
// database belong to the connector "local", and their user_id is the userID set in
// the Dex configuration.

/** Protobuf base-128 varint, for a field's length. */
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return bytes;
}

/** A length-delimited string field (wire type 2) with its tag byte. */
function stringField(tag: number, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from([tag, ...varint(bytes.length)]), bytes]);
}

/** The subject Dex gives userId of connector (field 1, tag 0x0a; field 2, tag 0x12). */
export function dexSubject(userId: string, connector = 'local'): string {
  return Buffer.concat([stringField(0x0a, userId), stringField(0x12, connector)]).toString(
    'base64url',
  );
}
