/** Only the private process owner constructs this after no dispatch or a
 * correlated native reply. Wire error codes alone do not prove settlement. */
export class NativeCommandRefusal extends Error {
  constructor(code, status, settlement) {
    super(code);
    if (!['not-dispatched', 'reply'].includes(settlement)) throw Error('native_command_settlement_invalid');
    this.code = code;
    this.status = status;
    Object.defineProperty(this, 'settlement', { value: settlement });
  }
}
