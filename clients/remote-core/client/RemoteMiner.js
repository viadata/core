class RemoteMiner extends RemoteClass {
    /**
     * Construct a remote miner connected over a remote connection.
     * @param remoteConnection - a remote connection to the server
     * @param live - if true, the miner auto updates and requests an event listener itself
     */
    constructor(remoteConnection, live) {
        super(RemoteMiner.IDENTIFIER, RemoteMiner.ATTRIBUTES, RemoteMiner.Events, remoteConnection);
        this.on(RemoteMiner.Events.HASHRATE_CHANGED, hashrate => this.hashrate = hashrate, !live);
        this.on(RemoteMiner.Events.STARTED, () => this.working = true, !live);
        this.on(RemoteMiner.Events.STOPPED, () => this.working = false, !live);
    }


    startWork() {
        this._remoteConnection.send({
            command: RemoteMiner.Commands.MINER_START_WORK
        });
    }


    stopWork() {
        this._remoteConnection.send({
            command: RemoteMiner.Commands.MINER_STOP_WORK
        });
    }


    /**
     * @async
     * @overwrite
     */
    _updateState() {
        return super._updateState().then(state => {
            this.address = Nimiq.Address.fromHex(state.address);
            return state;
        });
    }


    /**
     * @overwrite
     */
    _handleEvents(message) {
        if (message.type === RemoteMiner.MessageTypes.BLOCK_MINED) {
            const block = Nimiq.Block.unserialize(Nimiq.BufferUtils.fromBase64(message.data));
            this.fire(RemoteMiner.Events.BLOCK_MINED, block);
        } else {
            super._handleEvents(message);
        }
    }
}
RemoteMiner.IDENTIFIER = 'miner';
RemoteMiner.ATTRIBUTES = ['address', 'hashrate', 'working'];
RemoteMiner.Events = {
    STARTED: 'start',
    STOPPED: 'stop',
    HASHRATE_CHANGED: 'hashrate-changed',
    BLOCK_MINED: 'block-mined'
};
RemoteMiner.Commands = {
    MINER_START_WORK: 'miner-start-work',
    MINER_STOP_WORK: 'miner-stop-work'
};
RemoteMiner.MessageTypes = {
    MINER_STARTED: 'miner-start',
    MINER_STOPPED: 'miner-stop',
    MINER_HASHRATE_CHANGED: 'miner-hashrate-changed',
    MINER_BLOCK_MINED: 'miner-block-mined'
};

Class.register(RemoteMiner);