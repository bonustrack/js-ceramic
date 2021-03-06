import CID from 'cids'
import { validateLink } from "3id-blockchain-utils"
import { AccountLinkDoctype, AccountLinkParams } from "./account-link-doctype"
import {
    AnchorProof, AnchorStatus, DocState, DoctypeConstructor, DoctypeHandler, DocOpts, SignatureStatus
} from "@ceramicnetwork/ceramic-common"
import { Context } from "@ceramicnetwork/ceramic-common"

const DOCTYPE = 'account-link'

export class AccountLinkDoctypeHandler implements DoctypeHandler<AccountLinkDoctype> {
    /**
     * Gets doctype name
     */
    get name(): string {
        return DOCTYPE
    }

    /**
     * Gets doctype class
     */
    get doctype(): DoctypeConstructor<AccountLinkDoctype> {
        return AccountLinkDoctype
    }

    /**
     * Creates AccountLink instance
     * @param params - Create parameters
     * @param context - Ceramic context
     * @param opts - Initialization options
     */
    async create(params: AccountLinkParams, context: Context, opts?: DocOpts): Promise<AccountLinkDoctype> {
        return AccountLinkDoctype.create(params, context, opts);
    }

    /**
     * Applies record (genesis|signed|anchor)
     * @param record - Record to be applied
     * @param cid - Record CID
     * @param context - Ceramic context
     * @param state - Document state
     */
    async applyRecord(record: any, cid: CID, context: Context, state?: DocState): Promise<DocState> {
        if (state == null) {
            return this._applyGenesis(record, cid)
        }

        if (record.proof) {
            const proofRecord = (await context.ipfs.dag.get(record.proof)).value;
            return this._applyAnchor(record, proofRecord, cid, state);
        }

        return this._applySigned(record, cid, state);
    }

    /**
     * Applies genesis record
     * @param record - Genesis record
     * @param cid - Genesis record CID
     * @private
     */
    async _applyGenesis (record: any, cid: CID): Promise<DocState> {
        // TODO - verify genesis record
        return {
            doctype: DOCTYPE,
            content: null,
            next: {
                content: null
            },
            metadata: record.header,
            signature: SignatureStatus.GENESIS,
            anchorStatus: AnchorStatus.NOT_REQUESTED,
            log: [cid]
        }
    }

    /**
     * Applies signed record
     * @param record - Signed record
     * @param cid - Signed record CID
     * @param state - Document state
     * @private
     */
    async _applySigned (record: any, cid: CID, state: DocState): Promise<DocState> {
        const validProof = await validateLink(record.content)
        if (!validProof) {
            throw new Error('Invalid proof for signed record')
        }

        // TODO: handle CAIP-10 addresses in proof generation of 3id-blockchain-utils
        const account = validProof.account || validProof.address
        let [address, chainId] = account.split('@')  // eslint-disable-line prefer-const
        if (!chainId) {
            chainId = 'eip155:1'
        }

        const addressCaip10 = [address, chainId].join('@')
        if (addressCaip10.toLowerCase() !== state.metadata.owners[0].toLowerCase()) {
            throw new Error("Address doesn't match document owner")
        }
        state.log.push(cid)
        return {
            ...state,
            signature: SignatureStatus.SIGNED,
            anchorStatus: AnchorStatus.NOT_REQUESTED,
            next: {
                content: validProof.did
            }
        }
    }

    /**
     * Applies anchor record
     * @param record - Anchor record
     * @param proof - Anchor proof record
     * @param cid - Anchor record CID
     * @param state - Document state
     * @private
     */
    async _applyAnchor (record: any, proof: AnchorProof, cid: CID, state: DocState): Promise<DocState> {
        state.log.push(cid)
        let content = state.content
        if (state.next?.content) {
            content = state.next.content
            delete state.next.content
        }
        return {
            ...state,
            content,
            anchorStatus: AnchorStatus.ANCHORED,
            anchorProof: proof,
        }
    }

}
