class Balance {
    constructor(value = 0, nonce = 0) {
        if (!NumberUtils.isUint64(value)) throw 'Malformed value';
        if (!NumberUtils.isUint32(nonce)) throw 'Malformed nonce';

        this._value = value;
        this._nonce = nonce;
    }

    static of(o) {
        if (!o) return undefined;
        return new Balance(o._value, o._nonce);
    }

    static unserialize(buf) {
        let value = buf.readUint64();
        let nonce = buf.readUint32();
        return new Balance(value, nonce);
    }

    serialize(buf) {
        buf = buf || new Buffer(this.serializedSize);
        buf.writeUint64(this._value);
        buf.writeUint32(this._nonce);
        return buf;
    }

    get serializedSize() {
        return /*value*/ 8
            + /*nonce*/ 4;
    }

    get value() {
        return this._value;
    }

    get nonce() {
        return this._nonce;
    }
}