class TestBlockchain extends FullChain {
    static get MAX_NUM_TRANSACTIONS() {
        return Math.floor(              // round off
            (Policy.BLOCK_SIZE_MAX -    // block size limit
            150 -                       // header size
            20) /                       // miner address size
            165);                       // transaction size

    }

    constructor(store, accounts, users, ignorePoW = false) {
        // XXX Set a large timeout when mining on demand.
        if (TestBlockchain.MINE_ON_DEMAND && jasmine && jasmine.DEFAULT_TIMEOUT_INTERVAL) {
            jasmine.DEFAULT_TIMEOUT_INTERVAL = 1200000;
        }

        super(store, accounts);
        this._users = users;
        this._invalidNonce = ignorePoW;
        return this._init();
    }

    /** @type {Accounts} */
    get accounts() {
        return this._accounts;
    }

    /** @type {Array.<{address: Address, publicKey: PublicKey, privateKey: PrivateKey}>} */
    get users() {
        return this._users;
    }

    /**
     * @param {PublicKey} senderPubKey
     * @param {Address} recipientAddr
     * @param {number} amount
     * @param {number} fee
     * @param {number} validityStartHeight
     * @param {PrivateKey} [senderPrivKey]
     * @param {Signature} [signature]
     * @return {Promise.<BasicTransaction>}
     */
    static async createTransaction(senderPubKey, recipientAddr, amount = 1, fee = 1, validityStartHeight = 0, senderPrivKey = undefined, signature = undefined) {
        const transaction = new BasicTransaction(senderPubKey, recipientAddr, amount, fee, validityStartHeight);

        // allow to hardcode a signature
        if (!signature) {
            // if no signature is provided, the secret key is required
            if (!senderPrivKey) {
                throw 'Signature computation requested, but no sender private key provided';
            }
            signature = await Signature.create(senderPrivKey, senderPubKey, transaction.serializeContent());
        }
        transaction.signature = signature;

        return transaction;
    }

    /**
     * @param {PublicKey} senderPubKey
     * @param {Address} recipientAddr
     * @param {number} amount
     * @param {number} fee
     * @param {number} validityStartHeight
     * @param {PrivateKey} [senderPrivKey]
     * @param {Signature} [signature]
     * @return {Promise.<LegacyTransaction>}
     * @deprecated
     */
    static async createLegacyTransaction(senderPubKey, recipientAddr, amount = 1, fee = 1, validityStartHeight = 0, senderPrivKey = undefined, signature = undefined) {
        const transaction = new BasicTransaction(senderPubKey, recipientAddr, amount, fee, validityStartHeight);

        // allow to hardcode a signature
        if (!signature) {
            // if no signature is provided, the secret key is required
            if (!senderPrivKey) {
                throw 'Signature computation requested, but no sender private key provided';
            }
            signature = await Signature.create(senderPrivKey, senderPubKey, transaction.serializeContent());
        }
        transaction.signature = signature;

        return transaction;
    }

    // TODO can still run into balance problems: block height x and subsequent `mining` means that only the first x
    // users are guaranteed to have a non-zero balance. Depending on the existing transactions, this can improve a bit...
    async generateTransactions(numTransactions, noDuplicateSenders = true, sizeLimit = true) {
        const numUsers = this.users.length;

        if (noDuplicateSenders && numTransactions > numUsers) {
            // only one transaction per user
            numTransactions = numUsers;
        }

        if (sizeLimit && numTransactions > TestBlockchain.MAX_NUM_TRANSACTIONS) {
            Log.w(`Reducing transactions from ${numTransactions} to ${TestBlockchain.MAX_NUM_TRANSACTIONS} to avoid exceeding the size limit.`);
            numTransactions = TestBlockchain.MAX_NUM_TRANSACTIONS;
        }

        /* Note on transactions and balances:
         We fill up the balances of users in increasing order, therefore the size of the chain determines how many
         users already have a non-zero balance. Hence, for block x, all users up to user[x] have a non-zero balance.
         At the same time, there must not be more than one transaction from the same sender.
         */
        const transactions = [];
        for (let j = 0; j < numTransactions; j++) {
            const sender = this.users[j % numUsers];
            const recipient = this.users[(j + 1) % numUsers];

            // 10% transaction + 5% fee
            const account = await this.accounts.get(sender.address, Account.Type.BASIC);
            const amount = Math.floor(account.balance / 10) || 1;
            const fee = Math.floor(amount / 2);

            const transaction = await TestBlockchain.createTransaction(sender.publicKey, recipient.address, amount, fee, this.height, sender.privateKey);// eslint-disable-line no-await-in-loop

            transactions.push(transaction);
        }

        return transactions;
    }

    /**
     * @param {{prevHash, interlinkHash, bodyHash, accountsHash, nBits, timestamp, nonce, height, interlink, minerAddr, transactions, numTransactions}} options
     * @returns {Promise.<Block>}
     */
    async createBlock(options = {}) {
        const height = options.height || this.head.height + 1;

        let transactions = options.transactions;
        if (!transactions) {
            const numTransactions = typeof options.numTransactions !== 'undefined' ? options.numTransactions : height - 1;
            transactions = await this.generateTransactions(numTransactions);
        }

        const minerAddr = options.minerAddr || this.users[this.height % this._users.length].address;     // user[0] created genesis, hence we start with user[1]
        const body = new BlockBody(minerAddr, transactions);

        const nBits = options.nBits || BlockUtils.targetToCompact(await this.getNextTarget());
        const interlink = options.interlink || await this.head.getNextInterlink(BlockUtils.compactToTarget(nBits));

        const prevHash = options.prevHash || this.headHash;
        const interlinkHash = options.interlinkHash || await interlink.hash();
        const bodyHash = options.bodyHash || await body.hash();

        let accountsHash = options.accountsHash;
        if (!accountsHash) {
            const accountsTx = await this._accounts.transaction();
            try {
                await accountsTx.commitBlockBody(body, height, this._transactionsCache);
                accountsHash = await accountsTx.hash();
            } catch (e) {
                // The block is invalid, fill with broken accountsHash
                // TODO: This is harmful, as it might cause tests to succeed that should fail.
                accountsHash = new Hash(null);
            }
            await accountsTx.abort();
        }

        const timestamp = typeof options.timestamp !== 'undefined' ? options.timestamp : this.head.timestamp + Policy.BLOCK_TIME;
        const nonce = options.nonce || 0;
        const header = new BlockHeader(prevHash, interlinkHash, bodyHash, accountsHash, nBits, height, timestamp, nonce);

        const block = new Block(header, interlink, body);

        if (nonce === 0) {
            await this.setOrMineBlockNonce(block);
        }

        return block;
    }

    async setOrMineBlockNonce(block) {
        const hash = await block.hash();
        TestBlockchain.BLOCKS[hash.toBase64()] = block;

        if (TestBlockchain.NONCES[hash.toBase64()]) {
            block.header.nonce = TestBlockchain.NONCES[hash.toBase64()];
            if (!(await block.header.verifyProofOfWork())) {
                throw new Error(`Invalid nonce specified for block ${hash}: ${block.header.nonce}`);
            }
        } else if (TestBlockchain.MINE_ON_DEMAND) {
            console.log(`No nonce available for block ${hash.toHex()}, will start mining at height ${block.height} following ${block.prevHash.toHex()}.`);
            await TestBlockchain.mineBlock(block);
            TestBlockchain.NONCES[hash.toBase64()] = block.header.nonce;
        } else if (this._invalidNonce) {
            console.log(`No nonce available for block ${hash.toHex()}, but accepting invalid nonce.`);
        } else {
            throw new Error(`No nonce available for block ${hash}: ${block}`);
        }
    }

    /**
     * @param {number} numBlocks
     * @param {number} [numUsers]
     * @param {boolean} [ignorePoW]
     * @return {Promise.<TestBlockchain>}
     */
    static async createVolatileTest(numBlocks, numUsers = 2, ignorePoW = false) {
        const accounts = await Accounts.createVolatile();
        const store = ChainDataStore.createVolatile();
        const users = await TestBlockchain.getUsers(numUsers);
        const testBlockchain = await new TestBlockchain(store, accounts, users, ignorePoW);

        // populating the blockchain
        for (let i = 0; i < numBlocks; i++) {
            const newBlock = await testBlockchain.createBlock(); //eslint-disable-line no-await-in-loop
            const success = await testBlockchain.pushBlock(newBlock); //eslint-disable-line no-await-in-loop
            if (success !== FullChain.OK_EXTENDED) {
                throw 'Failed to commit block';
            }
        }

        return testBlockchain;
    }

    static async getUsers(count) {
        if (count > TestBlockchain.USERS.length) {
            throw `Too many users ${count} requested, ${TestBlockchain.USERS.length} available`;
        }

        const users = [];
        const keyPairs = TestBlockchain.USERS.slice(0, count)
            .map(encodedKeyPair => KeyPair.unserialize(BufferUtils.fromBase64(encodedKeyPair)));
        for (const keyPair of keyPairs) {
            const address = await keyPair.publicKey.toAddress(); // eslint-disable-line no-await-in-loop
            users.push(TestBlockchain.generateUser(keyPair, address));
        }
        return users;
    }

    static async generateUsers(count) {
        const users = [];

        // First user, it needs to be known beforehand because the
        // genesis block will send the first miner reward to it.
        // This keypair is the one that the miner address of the test genesis block in DummyData.spec.js belongs to.
        const keys = KeyPair.unserialize(BufferUtils.fromBase64(TestBlockchain.USERS[0]));
        const address = await keys.publicKey.toAddress();
        users.push(TestBlockchain.generateUser(keys, address));

        for (let i = 1; i < count; i++) {
            const keyPair = await KeyPair.generate(); //eslint-disable-line no-await-in-loop
            const address = await keyPair.publicKey.toAddress(); //eslint-disable-line no-await-in-loop

            users.push(TestBlockchain.generateUser(keyPair, address));
        }
        return users;
    }

    static generateUser(keyPair, address) {
        return {
            'keyPair': keyPair,
            'privateKey': keyPair.privateKey,
            'publicKey': keyPair.publicKey,
            'address': address
        };
    }

    static async mineBlock(block) {
        await TestBlockchain._miningPool.start();
        block.header.nonce = 0;
        const share = await new Promise((resolve, error) => {
            const temp = function (share) {
                if (share.block.header.equals(block.header)) {
                    TestBlockchain._miningPool.off('share', temp.id);
                    resolve(share);
                }
            };
            temp.id = TestBlockchain._miningPool.on('share', temp);
            TestBlockchain._miningPool.startMiningOnBlock(block).catch(error);
        });
        TestBlockchain._miningPool.stop();
        block.header.nonce = share.nonce;
        if (!(await block.header.verifyProofOfWork())) {
            throw 'While mining the block was succesful, it is still considered invalid.';
        }
        return share.nonce;
    }

    static async mineBlocks() {
        const nonces = {};
        for (const hash in TestBlockchain.BLOCKS) {
            if (TestBlockchain.NONCES[hash]) {
                nonces[hash] = TestBlockchain.NONCES[hash];
            } else {
                await TestBlockchain.mineBlock(TestBlockchain.BLOCKS[hash]).then(nonce => {
                    nonces[hash] = nonce;
                    Log.i(`'${hash}': ${nonce}`);
                });
            }
        }
        return nonces;
    }

    static async mineBlocksJSON() {
        TestBlockchain.NONCES = await TestBlockchain.mineBlocks();
        TestBlockchain.printNonces();
    }

    static printNonces() {
        const nonces = Object.assign({}, TestBlockchain.NONCES);
        for (const key of Object.keys(nonces)) {
            if (!TestBlockchain.BLOCKS[key]) {
                delete nonces[key];
            }
        }
        TestBlockchain._printNonces(nonces);
    }

    static _printNonces(nonces) {
        // XXX Primitive JSON pretty printer
        const json = JSON.stringify(nonces)
            .replace(/"/g, '\'')
            .replace(/:/g, ': ')
            .replace(/,/g, ',\n    ')
            .replace(/{/g, '{\n    ')
            .replace(/}/g, '\n}');
        console.log(json);
    }

}
TestBlockchain._miningPool = new MinerWorkerPool(4);

TestBlockchain.MINE_ON_DEMAND = false;

TestBlockchain.BLOCKS = {};
TestBlockchain.USERS = [ // ed25519 keypairs
    'Mmu0+Ql691CyuqACL0IW9DMYIdxAQXCWUQV1/+Yi/KHbtdCeGGSaS+0SPOflF9EgfGx5S+ISSOhGHv1HOT3WbA==', // This keypair is the one that the miner address of the test genesis block in DummyData.spec.js belongs to.
    'HJ3XZfRDoPMpyEOZFQiETJSPxCTQ97Okyq8bSTIw4em1zS3x9PdeWBYwYcgBCl05/sni79TX9eu8FiZ9hWSruA==',
    'xSYRx3GM0DPFi9icVtzodvnjck/7qcc/92YTRVXcqALVtCnpK7PZYIYb2ZUp2Y+tW3DHg12Vk/FI1oLUIny8RA==',
    'dNxnxlHjOrthMRIFpWmaNMCccqjXrlO/eaD2g+1jvh8grFl7ZN/P102AYogOWBGZayH74Fcf2KSfy1/rDlFMrg==',
    'JDfN8h0RHx51lMyY29UQcLjQR7ig9URcPPdxhRclhk/Wht9pnUIRXtzYWw742hlaOhJzkuOqqLg2oEM33hIV3Q==',
    'OBZNFtzBjrJwaYq3A+sB0zpGscmYaIHrULfP36LT+5+sF/roKPCiXMcqT7OcAfnNCfzo+x7cxaqcoNEm2+VDVA==',
    'LkC2ULxwljHcM4sFe6yA1eaYHPoPl4j2kh+5qtzPNr1vR95be3os01XpsINXwDHNucuevBGmzyJYbwgcUsFRiA==',
    '2r62ml0RiVd+Wxb/Ef3QsNuCkElNgit6+VQpiPg5Vo8jLY4WEX/L1OL/pJOvLfsnIvb+HTOmCA6M4vpOJRb59g==',
    'kVuy+yezfkkaTRxT47bLMID+JzvyTD3LzQEJTKk8X/RMJaaGSYsDiz68fxtS6m+SSdv1MUSogYz07K3wdr+nng==',
    '8+P/0UlVK/jlFVQBK9Lr4cv4sLXVLiL8T/ahU0wXOYD9hAwqH2/GX7ghf8pO+0AcyBPbBBh+Wy7GgKxFLZ1YdA==',
    'vR8sgRd+wa+n7ymTHB77h2TS91JTvp8pJSH7/c/dZlL91+BMMuXbSr7MBjEPw1rf7qULOts+/zAvnfY/IYsnJA==',
    '1R/x+Mb9PtWkyv3nZpyL1QT19hGj6QaH7cHd0yArZWhl7aiwZ4exu9uX96/TsxgXRX4LA5tZ895IXswXZvnDBg==',
    'aRBGIzF50FEWQoStq/hwKl/50YqvqjSxkBUu9BJ4HVYEZEQdbKu1JDr6/DX8gIT9mC2TQZriK7VNMUVXfSEhPQ==',
    'Uub9Wb4pzoX2cEKwJErP5LoqELtRFeF5BRnW4Y9lZRJNQwmIYnUr6uFb50o2aN4iYlq1s1GsAE8c9gZyTsO6IA==',
    'GfC3EOtTnlMM0z7A8dnwKuA4y1DSIQuwCs8FFRYrhL6lVs4r5QQSJlnuhYjGFSE5m+3392ELkvYNmEQL28u9Mg==',
    'lxFSrIseX4bGZYJY/FrWjEtFZ4coJucoIjab9jc8675mTwkPuB7t7BCmaPPN67WxQFD0Qj5vw1NUQ66q1SrtdA==',
    'zGLx8jnMMGP5T7enK/BQTPc47vuzl+yy07Wcs161wGK0Q5uSlGK6IfF50MRgs1Wn0sNeLqbILEk/KIZUy07erA==',
    'I+zEE/RCxbLOtRA90bVu+zrqFg7nS6MUTn+2f5fbQ3O9jio9dwuFTkrgVLEGe9QbvVGC7NP3bIsjwNvgx3q2eQ==',
    '1Oz7m7esArq2k0AXqHxUwjFcI8DGfR63MUUMuGuvcG+GP7VA5dw5NlR3i2uF5kHEy9wWB64iz/hP9RxXItJAnA==',
    'X/06OWBfaMkHRPjtbzSXx2A1BcrJy6mUl7ndXiqAjK/FHSMI64mJ0VpPR3d8QwphDDUfaHHKt8in26vvUKCUIA==',
    '6krkaWJRA/BrSXjU+dAzRGq9DtNjEEGR45gF0Obyv5elzSSGnO5+VgGItN2StcKfdpmkLFSFm91Na34FEywIsA==',
    'rUjEeM4Hj1xI/GKenLd335fIn4/+wYTqTQB0G6W+AxIzp1fnNY5AMusg8+fab3f6j5DVJDy9OCif5ZiP4RjaBA==',
    'RqaLfBj53rhPWZggf9l7OGyf1QvYazUoHCrep9lKNcn82XSH1cQbTuaGo0YRkpJlSp029uG70LOm//whFGSiag==',
    'YhnMyCfXwdIRcul1TAZbBU7IsASMlC/2Vhmr/gwFjiMi1OlO3DNdnzd70aOHzoYyXSxdtqWGKcEGOn/AtgUSaw==',
    'g2/wZc1CCHBZAajOs0yHBiIj+YTBKf2kFqg4feCj6qNy5yilcUR752g6MC3pV0scZbEzqLzK1kZ5tnxOjbZYJw=='
];
TestBlockchain.NONCES = {
    'oJFAH4+DmE/ZZWaVAgASCtPSBxKVnq+T46o0PThtRaQ=': 182374,
    'scPgbZE9pZb4jHbnofXSmQxA2W0GJ8paZxKYQtnkS9A=': 53213,
    'Zb/r/KmkpvcTC8IiT5PYPNxuGRlLyiJ7rFnnhrPyEf0=': 13601,
    'aZtm4zG+BxLWHBKWx50u9QUURhScO9kntfzFbH0FrKo=': 105279,
    'nEe8HJGHY1SzdIJ866iRO4nvg3+5UU+LVHSmC+DeoHQ=': 214235,
    'lStAt/MMYJQ9OZktjgPiBDjqareo8Lf/C3l/Fa9tiOI=': 31119,
    '9RRD2k706N7M/Kosz6uINCVPBNxDne/iyfCxmIMk/dA=': 86453,
    'QUKfiOAZZMXqvltcFRh0toQpv4RuwjWUEXdrBqXCngs=': 16783,
    'RXhNtuBwFCJXx4Fb8CFHAnWwYw6Qkj+D36+YnkzdmLg=': 39069,
    'CbezZRbEc9ErvtFnyPBdtSdN2qaSRDPKa1wtIjCV+5s=': 55208,
    'CwTMmSNGV6xLBxcID125LjXgDnO4omXiFsTqIkhDVqA=': 60527,
    'f1LJyoSBkzfdSLIMttGXFAiZfU4ECqBRDUYFcdoS1Bs=': 75627,
    '5t/G9NG6gXSTBwYEdy5mzm9qwGNZ6eofHZ+IeegNxTk=': 124147,
    'KOFwqxsUhcqpc3iwu3ZL5XH5CNmBKnUx09h8ThycJMQ=': 58763,
    'ke0xGHFdrXyy4aWcIXbRFYEJA2VOXRqmifdkbY4un2A=': 42849,
    'bwh5Jg5bPP49/eXIW5S9ABwmBK46gIadzdjJqsb4KNA=': 15074,
    'ey/NS/s7T8/DO6VPC+ndix0Eq5/+uqgsljXpX8XckPg=': 90048,
    'jynLED/PZW7IwF9+uwxMPdlHMvVhxb90mKNEyF8OMsQ=': 7973,
    'Yalg17HayzyvhOgwcJXXOrwvFzxGKRtoQyJvYbQ1yOY=': 56614,
    'pNeKbkuRsynVN4qCOy4vND4D3YpBohoS+z9VpGZZStg=': 178959,
    'shWOy4rXisb6Lg36pM70WJxMaDe/9QycZFxDUiTUECI=': 140133,
    'dhFk+bYXMhDfrjhoJ05BSgQchoLDGaX0TsKET/ykUlg=': 63673,
    'Kr06v+J1AygLoLmC4DNxejBOYVcaFKpV9Hc/s7dspVA=': 95765,
    'R3zXECY+H/da5hR0XOBg09H7+VzUXncM9afmJ+JLikc=': 60862,
    '7Fv2UasgLbYcJRNAhEoOh1tnJOKEMHJ5jaO4wx1GtBw=': 2672,
    'R4JM2zmj5dWEr5SSyplTDkEzi17EMDiPCS3cYrpFwqc=': 23108,
    'a4IfTyFTh6amn7YIhImJdITuw3i0RpUFe+Zg3wGmcRs=': 8205,
    's1woVEsuc6HD7UZR8TNO/H2rwKj61WQ7JwPRak1uw28=': 70215,
    'p5vFs8+9XBjJaxEKqwhfWSAvANITspox+p7EOGBTSeo=': 73435,
    'YQTkzC3SlAtaK7efUfkYRM5fTOl3IdluWTHA+TOnmdc=': 43578,
    'TDloK6tkfzmHQ5CTXX2TFDF4toRpbkPXM5Oa22x37aM=': 32226,
    'fX+fQjq9fszVJJnbZ/pgatGp8axwBFpmPwXqciqZniA=': 1579,
    'J8GE1vZtR9dFj6U4YnPmCdg8yfq8JFyNXTFYb+Axonw=': 70725,
    'OnYi2TloDWLKDHhWOdJCOMEvE2+oyOQd+lGkPt9OsWU=': 162703,
    'SM0kff05GKl/URyczeOrf3wdi5oEiU6CGrNK5pCrvAI=': 30312,
    'robzjALxCUqGWJHWQQ+pJWoEjPhq+qBuwsM7USD2vC4=': 223861,
    'oMkuvXhqcHw2kfZDjy/FpukW290nYCkAEP73XHCff90=': 3072,
    'uLyBhbzrq4h+6O3KjmBErqRnUWeO/wINphcxX08BwWs=': 9342,
    'cvoFWEiytcXgAQwLChOnjnnufM3R6OrOBSrXGEZmUNY=': 78347,
    '55UUwuJrTusvFUiKDWfRQ8HhloWez0giaDrVsc0Y8EY=': 29275,
    'bRfxYw/SNpsh0SoNBjvxMJkqQO3evVRFcvdkkVbuabc=': 30882,
    'Qu3Ni6v+IhKDOnPxa6pj22tnaQb8ImisEvDf96pTpVg=': 172715,
    'x8x8e/Zr6/gH0R1Bl89IDFUh7qgDZOGjH3k4WsB538A=': 72907,
    'sJy688yjGqpDzkpCKc77N28h7IAolVGXWuB3CybkKi4=': 84357,
    '+yhp11Ou0swSgWIBGAQXgVqkk7mEF3hJ3bwaLoyCRJA=': 37976,
    '5GCN+BK9+SucqjHyvLXYXEPd2rkOETscZMN1dt+/biE=': 15004,
    'iqwjZ+3zfbx9DI91OOm2Myl5YcaedqTEZkz3aB/dUq4=': 213408,
    'BzJHP7BGCWRjHyJx8zoMkz/FcHm7hrh+VitxP7Cbh30=': 204509,
    'c1LfYD0NstO3QESIqT4s1ZKrNO4KWgdZg2lJkNjF/zI=': 61473,
    'QBOhpdcVJF/KJrYaTeng6L2eUxR1fEgYs9V9mTVYbCg=': 5236,
    'uVmA+JSFo+N6g0DLTMY7UfNnVAzqz1LbbI2aSjGIhyU=': 10010,
    'ZfXeloZUknn7amh4YrJ67mr6m+S/b31SlH59Q8uf4J4=': 28871,
    'qcxbKExoyhP8vkDE7+Go9TWI27ITHBQAzLGr4eH6W+U=': 81828,
    'goAplQupmu4UkZF6Gcx/2ZQwOFniOUCmwlIFRFAqmbU=': 50346,
    'hxm9Wkyom8LJ24KrxG5eb8D0Fel2DgYSb6Y+wrCW558=': 139183,
    'nncm+AId14nnWHG23NUT2CsESEi/xsCbdpc/AGW5pTk=': 29667,
    '7/vCWDQBuiSBnS8gkzqvBWAUsyVTT/JEbll3TTDYhWg=': 43891,
    'zpQKb6CBQyBsmbRj7N/NgPZnSb7p22SOajr24JqPDbw=': 874,
    'QjtmTIjgsoToXUhBPiVHOW0S4gaX+mprrVFj7Wyi+Cc=': 61914,
    'xmOy0nPLNvpueOo8md/uZHINPVjUrHfKvD5UZOzo6N0=': 45481,
    'qs/10/c8/aoL9Kirb6eRsJPrVbj50vzpHW07rmSGBMM=': 75417,
    'WAGP8UdObvSKJ9qJlH8XS9FqXnkysG60+dlgCszz0HE=': 115038,
    'J1jgvDJvrAKiGpsWjDRkLKb+PgzkAotwXQZmMXLH5z0=': 30510,
    '8w3xJ91RBIoC3Qrrr8uzEUtjATLkOckYSX7yRs3QAhY=': 28429,
    '6LQfdKRw9dHcSz2BBj/RsJVlXlFbWte1kHVU/j/T1WM=': 107824,
    'NLQ+Minyzj/WyeBkG07yqIKOS4ONuRUhs4ytNoaVfIQ=': 138747,
    'bevsx7nlaaCngGoyKY5bAbbhqRK0L1Xlh7+3e9wi200=': 899,
    'QbLjAhABcmRwZwCXVo3pnNQ6FJii/MC/kTEPhRCB5oo=': 33965,
    '8ydY5tD/REYr93q2wQPAJ4ITuldtGpcnrLEBJPjEeos=': 2000,
    'wgbvx0SeWS8W0hCODwVbBNRkSdtFmgFbjFNhGYazRQw=': 6323,
    '0Nf90f+1/uHVHEjIk4o5Uj+KOXgcXZPdq1CdQou3cms=': 25419,
    'kkBW2WGjjEHdqX7cxlkfLGRRdgLPi05WTlQwclAIJUI=': 84401,
    'd1lctszg9yQwAuEUzttpOWVo1nohQN9KnPfLG+5dyBc=': 71107,
    'ZH143UL1Ai51xFqjtWP2KTOm/aQudIiX8nE7xuwjDtM=': 198,
    'W4/gVgxd8SShx6I3iVv+0smwzfC1qHaNiHc9TWeEO1U=': 34019,
    '24Gl/7ObZEMY/DFi/2nr2F7SsitZGF5N5P3/6Sd9zXg=': 33977,
    'HThYaVOU1Bti0DEWnBgkshFUfiUr+ZxhG3cop60dYfA=': 133419,
    'mfcPCdMm8csHRQrT1COSTIFWVZxV2yRRcFc76T3aVLc=': 15967,
    'cUnA6qbtO25omPZ0rAjau5d4C8RlU9hyhy4emuM2q58=': 52162,
    'TEVT5uB6tOWzpUMO65+1bxqwv4D8eGfMO0krfEoW5lE=': 44084,
    's5zfg+QnFPhN441wb81EJCh483vEqBaGcOpbqC/npeg=': 6492,
    'GhM5NJGsMBFs8dGKH6TxOZDXgxawe2ii3+Lx3pQHBhg=': 114183,
    'oExN/JmWcIBKMytcwTA7fnm1Bw6zWwwy4xC1gw0Ng9c=': 44014,
    'iNE6dsBoV8ai7l/wFH+NB0mm3wxXelZxPiA3soIzeOM=': 47363,
    'x22iZpOB8B6/ykkATuIftyM8gCWlRkpK/Vkh4W4Z4sY=': 1895
};
Class.register(TestBlockchain);
