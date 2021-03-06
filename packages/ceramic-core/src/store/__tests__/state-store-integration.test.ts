import tmp from 'tmp-promise'
import Document from "../../document"
import Dispatcher from "../../dispatcher"
import MockAnchorService from "../../anchor/mock/mock-anchor-service"
import { Doctype } from "@ceramicnetwork/ceramic-common"
import { AnchorService } from "@ceramicnetwork/ceramic-common"
import { Context } from "@ceramicnetwork/ceramic-common"
import { TileDoctype, TileDoctypeHandler } from "@ceramicnetwork/ceramic-doctype-tile"
import {PinStore} from "../pin-store";
import {PinStoreFactory} from "../pin-store-factory";
import { DID } from 'dids'

import { Resolver } from "did-resolver"
import ThreeIdResolver from '@ceramicnetwork/3id-did-resolver'

// mock Dispatcher
jest.mock('../../dispatcher', () => {
  const CID = require('cids') // eslint-disable-line @typescript-eslint/no-var-requires
  const cloneDeep = require('lodash.clonedeep') // eslint-disable-line @typescript-eslint/no-var-requires
  const { sha256 } = require('js-sha256') // eslint-disable-line @typescript-eslint/no-var-requires
  const { DoctypeUtils } = require('@ceramicnetwork/ceramic-common') // eslint-disable-line @typescript-eslint/no-var-requires
  const dagCBOR = require('ipld-dag-cbor') // eslint-disable-line @typescript-eslint/no-var-requires
  const hash = (data: string): CID => new CID(1, 'sha2-256', Buffer.from('1220' + sha256(data), 'hex'))

  return (gossip: boolean): any => {
    const pinnedDocIds: Record<string, boolean> = {}
    const recs: Record<any, any> = {}
    const docs: Record<string, Document> = {}
    const deepResolve = (cid: CID, remaining: string[]): CID => {
      if (remaining.length > 0) {
        const record = recs[cid.toString()]
        const next = record[remaining[0]] as CID
        return deepResolve(next, remaining.slice(1))
      } else {
        return cid
      }
    }
    return {
      _ipfs: {
        id: (): any => ({ id: 'ipfsid' }), dag: {
          put(rec: any): any {
            // stringify as a way of doing deep copy
            const clone = cloneDeep(rec)
            const cid = hash(JSON.stringify(clone))
            recs[cid.toString()] = clone
            return cid
          },
          get(cid: any): any {
            return {
              value: recs[cid.toString()]
            }
          },
          resolve(query: string) {
            const path = query.split('/')
            const cid = new CID(path[0])
            return deepResolve(cid, path.slice(1))
          }
        },
        pin: {
          add: jest.fn((cid: string) => {
            pinnedDocIds[cid] = true
            return
          }), rm: jest.fn((cid: string) => {
            delete pinnedDocIds[cid]
            return
          }), ls: jest.fn((cid?: string): AsyncIterable<string> => {
            let keys: string[];
            if (cid) {
              keys = pinnedDocIds[cid] ? [cid] : []
            } else {
              keys = Object.keys(pinnedDocIds)
            }
            return {
              [Symbol.asyncIterator](): any {
                let index = 0
                return {
                  next(): any {
                    if (index === keys.length) {
                      return Promise.resolve({ value: null, done: true });
                    }
                    return Promise.resolve({ value: keys[index++], done: false });
                  }
                };
              }
            }
          })
        },
      },
      register: jest.fn((doc) => {
        docs[doc.id] = doc
      }),
      storeRecord: jest.fn(async (rec) => {
        if (DoctypeUtils.isSignedRecordDTO(rec)) {
          const { jws, linkedBlock } = rec
          const block = dagCBOR.util.deserialize(linkedBlock)

          const cidLink = hash(JSON.stringify(block))
          recs[cidLink.toString()] = block

          const clone = cloneDeep(jws)
          clone.link = cidLink
          const cidJws = hash(JSON.stringify(clone))
          recs[cidJws.toString()] = clone
          return cidJws
        }

        // stringify as a way of doing deep copy
        const clone = cloneDeep(rec)
        const cid = hash(JSON.stringify(clone))
        recs[cid.toString()] = clone
        return cid
      }),
      publishHead: jest.fn((id, head) => {
        if (gossip) {
          docs[id]._handleHead(head)
        }
      }),
      _requestHead: (id: string): void => {
        if (gossip) {
          docs[id]._publishHead()
        }
      },
      retrieveRecord: jest.fn(cid => {
        return recs[cid.toString()]
      }),
      retrieveRecordByPath: jest.fn((cid) => {
        const rootCid = recs[cid.toString()].root
        return recs[rootCid.toString()]
      }),
      pinnedDocIds,
      recs,
    }
  }
})

const anchorUpdate = (doctype: Doctype): Promise<void> => new Promise(resolve => doctype.on('change', resolve))

describe('Level data store', () => {

  const initialContent = { abc: 123, def: 456 }
  const owners = ['did:3:bafyasdfasdf']

  let store: PinStore
  let dispatcher: Dispatcher
  let doctypeHandler: TileDoctypeHandler
  let anchorService: AnchorService
  let context: Context

  beforeEach(async () => {
    dispatcher = Dispatcher()
    dispatcher.pinnedDocIds = {}
    dispatcher.recs = {}

    dispatcher._ipfs.pin.ls.mockClear()
    dispatcher._ipfs.pin.rm.mockClear()
    dispatcher._ipfs.pin.add.mockClear()

    anchorService = new MockAnchorService(dispatcher)

    const user: DID = new DID()
    user.createJWS = jest.fn(async () => {
      // fake jws
      return 'eyJraWQiOiJkaWQ6MzpiYWZ5YXNkZmFzZGY_dmVyc2lvbj0wI3NpZ25pbmciLCJhbGciOiJFUzI1NksifQ.bbbb.cccc'
    })
    user._id = 'did:3:bafyasdfasdf'

    const threeIdResolver = ThreeIdResolver.getResolver({
      loadDocument: (): any => {
        return Promise.resolve({
          content: {
            "publicKeys": {
              "signing": "zQ3shwsCgFanBax6UiaLu1oGvM7vhuqoW88VBUiUTCeHbTeTV",
              "encryption": "z6LSfQabSbJzX8WAm1qdQcHCHTzVv8a2u6F7kmzdodfvUCo9"
            }
          }
        })
      }
    })

    context = {
      ipfs: dispatcher._ipfs,
      did: user,
      resolver: new Resolver({
        ...threeIdResolver
      }),
      anchorService,
    }

    doctypeHandler = new TileDoctypeHandler()
    doctypeHandler.verifyJWS = async (): Promise<void> => { return }

    const levelPath = await tmp.tmpName()
    const storeFactory = new PinStoreFactory(context, levelPath, ['ipfs+context'])
    store = await storeFactory.open()
  })

  it('pins document correctly without IPFS pinning', async () => {
    const genesis = await TileDoctype.makeGenesis({ content: initialContent, metadata: { owners, tags: ['3id'] } }, context)
    const genesisCid = await dispatcher.storeRecord(genesis)
    const doc = await Document.create(genesisCid, doctypeHandler, dispatcher, store, context)
    await anchorUpdate(doc.doctype)

    let docState = await store.stateStore.load(doc.id)
    expect(docState).toBeNull()

    await store.stateStore.save(doc.doctype)
    expect(dispatcher._ipfs.pin.add).toHaveBeenCalledTimes(0)

    docState = await store.stateStore.load(doc.id)
    expect(docState).toBeDefined()
  })

  it('pins not anchored document correctly with IPFS pinning', async () => {
    const genesis = await TileDoctype.makeGenesis({ content: initialContent, metadata: { owners, tags: ['3id'] } }, context)
    const genesisCid = await dispatcher.storeRecord(genesis)
    const doc = await Document.create(genesisCid, doctypeHandler, dispatcher, store, context, {
      applyOnly: true, skipWait: true,
    })

    let docState = await store.stateStore.load(doc.id)
    expect(docState).toBeNull()

    await store.add(doc.doctype)
    expect(dispatcher._ipfs.pin.add).toHaveBeenCalledTimes(1)

    docState = await store.stateStore.load(doc.id)
    expect(docState).toBeDefined()
  })

  it('pins document correctly with IPFS pinning', async () => {
    const genesis = await TileDoctype.makeGenesis({ content: initialContent, metadata: { owners, tags: ['3id'] } }, context)
    const genesisCid = await dispatcher.storeRecord(genesis)
    const doc = await Document.create(genesisCid, doctypeHandler, dispatcher, store, context)
    await anchorUpdate(doc.doctype)

    let docState = await store.stateStore.load(doc.id)
    expect(docState).toBeNull()

    await store.add(doc.doctype)
    expect(dispatcher._ipfs.pin.add).toHaveBeenCalledTimes(4)

    docState = await store.stateStore.load(doc.id)
    expect(docState).toBeDefined()
  })

  it('removes pinned document', async () => {
    const genesis = await TileDoctype.makeGenesis({ content: initialContent, metadata: { owners, tags: ['3id'] } }, context)
    const genesisCid = await dispatcher.storeRecord(genesis)
    const doc = await Document.create(genesisCid, doctypeHandler, dispatcher, store, context)
    await anchorUpdate(doc.doctype)

    await store.add(doc.doctype)
    expect(dispatcher._ipfs.pin.add).toHaveBeenCalledTimes(4)

    await store.rm(doc.id)
    expect(dispatcher._ipfs.pin.rm).toHaveBeenCalledTimes(4)
  })

  it('skips removing unpinned document', async () => {
    const genesis = await TileDoctype.makeGenesis({ content: initialContent, metadata: { owners, tags: ['3id'] } }, context)
    const genesisCid = await dispatcher.storeRecord(genesis)
    const doc = await Document.create(genesisCid, doctypeHandler, dispatcher, store, context)
    await anchorUpdate(doc.doctype)

    await store.rm(doc.id)
    expect(dispatcher._ipfs.pin.rm).toHaveBeenCalledTimes(0)
  })

  it('lists pinned documents', async () => {
    const genesis = await TileDoctype.makeGenesis({ content: initialContent, metadata: { owners, tags: ['3id'] } }, context)
    const genesisCid = await dispatcher.storeRecord(genesis)
    const doc = await Document.create(genesisCid, doctypeHandler, dispatcher, store, context)
    await anchorUpdate(doc.doctype)

    await store.add(doc.doctype)
    expect(dispatcher._ipfs.pin.add).toHaveBeenCalledTimes(4)

    let pinned = []
    let iterator = await store.ls(doc.id)
    for await (const id of iterator) {
      pinned.push(id)
    }
    expect(pinned.length).toEqual(1)
    expect(dispatcher._ipfs.pin.ls).toHaveBeenCalledTimes(0)

    pinned = []
    iterator = await store.ls()
    for await (const id of iterator) {
      pinned.push(id)
    }
  })

  it('lists empty for unpinned document', async () => {
    const genesis = await TileDoctype.makeGenesis({ content: initialContent, metadata: { owners, tags: ['3id'] } }, context)
    const genesisCid = await dispatcher.storeRecord(genesis)
    const doc = await Document.create(genesisCid, doctypeHandler, dispatcher, store, context)
    await anchorUpdate(doc.doctype)

    const pinned = []
    const iterator = await store.ls(doc.id)
    for await (const id of iterator) {
      pinned.push(id)
    }
    expect(pinned.length).toEqual(0)
    expect(dispatcher._ipfs.pin.ls).toHaveBeenCalledTimes(0)
  })
})
