// Never render child-controlled bytes or exception text: secrets may be unknown,
// split across writes, UTF-8 boundaries, or cut at any capture limit.
export function streamDiagnostic(stream) {
 const bytes=Buffer.concat(stream.chunks);
 const category=bytes.includes(Buffer.from('startup import failure'))
  ? 'startup import failure' : bytes.length ? 'child output omitted' : 'no child output';
 return category+(stream.truncated?'\n[output truncated]':'');
}

export function workerFailureDiagnostic() {
 return 'fixture worker failed; inspect the synthetic fixture and its startup dependencies';
}
