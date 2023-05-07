import {
  getConcurrentMerkleTreeAccountSize,
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  SPL_NOOP_PROGRAM_ID,
} from "@solana/spl-account-compression";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  AccountMeta,
  SYSVAR_RENT_PUBKEY,
  Signer,
} from "@solana/web3.js";
import { WrappedConnection } from "./wrappedConnection";
import {
  createCreateTreeInstruction,
  createDecompressV1Instruction,
  createMintToCollectionV1Instruction,
  createRedeemInstruction,
  createTransferInstruction,
  MetadataArgs,
  PROGRAM_ID as BUBBLEGUM_PROGRAM_ID,
  TokenProgramVersion,
  TokenStandard,
} from "@metaplex-foundation/mpl-bubblegum";
import {
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
  createCreateMetadataAccountV3Instruction,
  createCreateMasterEditionV3Instruction,
  createSetCollectionSizeInstruction,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { BN } from "@project-serum/anchor";
import {
  bufferToArray,
  execute,
  getBubblegumAuthorityPDA,
  getMasterEdition,
  getMetadata,
  getVoucherPDA,
} from "./helpers";
import { bs58 } from "@project-serum/anchor/dist/cjs/utils/bytes";

// Creates a new merkle tree for compression.
export const initTree = async (
  connectionWrapper: WrappedConnection,
  payerKeypair: Keypair,
  treeKeypair: Keypair,
  maxDepth: number = 14,
  maxBufferSize: number = 64
) => {
  const payer = payerKeypair.publicKey;
  const space = getConcurrentMerkleTreeAccountSize(maxDepth, maxBufferSize);
  const [treeAuthority, _bump] = await PublicKey.findProgramAddress(
    [treeKeypair.publicKey.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  );
  const allocTreeIx = SystemProgram.createAccount({
    fromPubkey: payer,
    newAccountPubkey: treeKeypair.publicKey,
    lamports: await connectionWrapper.getMinimumBalanceForRentExemption(space),
    space: space,
    programId: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  });
  const createTreeIx = createCreateTreeInstruction(
    {
      merkleTree: treeKeypair.publicKey,
      treeAuthority,
      treeCreator: payer,
      payer,
      logWrapper: SPL_NOOP_PROGRAM_ID,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    },
    {
      maxBufferSize,
      maxDepth,
      public: false,
    },
    BUBBLEGUM_PROGRAM_ID
  );
  let tx = new Transaction().add(allocTreeIx).add(createTreeIx);
  tx.feePayer = payer;
  try {
    await sendAndConfirmTransaction(
      connectionWrapper,
      tx,
      [treeKeypair, payerKeypair],
      {
        commitment: "confirmed",
        skipPreflight: true,
      }
    );
    console.log(
      "Successfull created merkle tree for account: " + treeKeypair.publicKey
    );
  } catch (e) {
    console.error("Failed to create merkle tree: ", e);
    throw e;
  }
};

// Creates a metaplex collection NFT
export const initCollection = async (
  connectionWrapper: WrappedConnection,
  payer: Keypair
) => {
  const collectionMint = await Token.createMint(
    connectionWrapper,
    payer,
    payer.publicKey,
    payer.publicKey,
    0,
    TOKEN_PROGRAM_ID
  );
  const collectionTokenAccount = await collectionMint.createAccount(
    payer.publicKey
  );
  await collectionMint.mintTo(collectionTokenAccount, payer, [], 1);
  const [collectionMetadataAccount, _b] = await PublicKey.findProgramAddress(
    [
      Buffer.from("metadata", "utf8"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      collectionMint.publicKey.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
  const collectionMeatadataIX = createCreateMetadataAccountV3Instruction(
    {
      metadata: collectionMetadataAccount,
      mint: collectionMint.publicKey,
      mintAuthority: payer.publicKey,
      payer: payer.publicKey,
      updateAuthority: payer.publicKey,
    },
    {
      createMetadataAccountArgsV3: {
        data: {
          name: "Nick's collection",
          symbol: "NICK",
          uri: "nicksfancyuri",
          sellerFeeBasisPoints: 100,
          creators: null,
          collection: null,
          uses: null,
        },
        isMutable: false,
        collectionDetails: null,
      },
    }
  );
  const [collectionMasterEditionAccount, _b2] =
    await PublicKey.findProgramAddress(
      [
        Buffer.from("metadata", "utf8"),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        collectionMint.publicKey.toBuffer(),
        Buffer.from("edition", "utf8"),
      ],
      TOKEN_METADATA_PROGRAM_ID
    );
  const collectionMasterEditionIX = createCreateMasterEditionV3Instruction(
    {
      edition: collectionMasterEditionAccount,
      mint: collectionMint.publicKey,
      mintAuthority: payer.publicKey,
      payer: payer.publicKey,
      updateAuthority: payer.publicKey,
      metadata: collectionMetadataAccount,
    },
    {
      createMasterEditionArgs: {
        maxSupply: 0,
      },
    }
  );

  const sizeCollectionIX = createSetCollectionSizeInstruction(
    {
      collectionMetadata: collectionMetadataAccount,
      collectionAuthority: payer.publicKey,
      collectionMint: collectionMint.publicKey,
    },
    {
      setCollectionSizeArgs: { size: 50 },
    }
  );

  let tx = new Transaction()
    .add(collectionMeatadataIX)
    .add(collectionMasterEditionIX)
    .add(sizeCollectionIX);
  try {
    const sig = await sendAndConfirmTransaction(
      connectionWrapper,
      tx,
      [payer],
      {
        commitment: "confirmed",
        skipPreflight: true,
      }
    );
    console.log(
      "Successfull created NFT collection with collection address: " +
        collectionMint.publicKey.toBase58(),
      sig
    );
    return {
      collectionMint,
      collectionMetadataAccount,
      collectionMasterEditionAccount,
    };
  } catch (e) {
    console.error("Failed to init collection: ", e);
    throw e;
  }
};

export const getCollectionDetailsFromMintAccount = async (
  connectionWrapper: WrappedConnection,
  collectionMintAccount: PublicKey,
  payer: Keypair
) => {
  const collectionMint = new Token(
    connectionWrapper,
    collectionMintAccount,
    TOKEN_PROGRAM_ID,
    payer
  );
  const [collectionMetadataAccount, _b] = await PublicKey.findProgramAddress(
    [
      Buffer.from("metadata", "utf8"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      collectionMintAccount.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
  const [collectionMasterEditionAccount, _b2] =
    await PublicKey.findProgramAddress(
      [
        Buffer.from("metadata", "utf8"),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        collectionMintAccount.toBuffer(),
        Buffer.from("edition", "utf8"),
      ],
      TOKEN_METADATA_PROGRAM_ID
    );

  return {
    collectionMint,
    collectionMetadataAccount,
    collectionMasterEditionAccount,
  };
};

export const mintCompressedNft = async (
  connectionWrapper: WrappedConnection,
  nftArgs: MetadataArgs,
  ownerKeypair: Keypair,
  tree: PublicKey,
  collectionMint: PublicKey
) => {
  const [treeAuthority, _bump] = await PublicKey.findProgramAddress(
    [tree.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  );
  const [bgumSigner, __] = await PublicKey.findProgramAddress(
    [Buffer.from("collection_cpi", "utf8")],
    BUBBLEGUM_PROGRAM_ID
  );
  const mintIx = createMintToCollectionV1Instruction(
    {
      merkleTree: tree,
      treeAuthority,
      treeDelegate: ownerKeypair.publicKey,
      payer: ownerKeypair.publicKey,
      leafDelegate: ownerKeypair.publicKey,
      leafOwner: ownerKeypair.publicKey,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      logWrapper: SPL_NOOP_PROGRAM_ID,
      collectionAuthority: ownerKeypair.publicKey,
      collectionAuthorityRecordPda: BUBBLEGUM_PROGRAM_ID,
      collectionMint: collectionMint,
      collectionMetadata: await getMetadata(collectionMint),
      editionAccount: await getMasterEdition(collectionMint),
      bubblegumSigner: bgumSigner,
      tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
    },
    {
      metadataArgs: Object.assign(nftArgs, {
        collection: { key: collectionMint, verified: false },
      }),
    }
  );
  const tx = new Transaction().add(mintIx);
  tx.feePayer = ownerKeypair.publicKey;
  try {
    const sig = await sendAndConfirmTransaction(
      connectionWrapper,
      tx,
      [ownerKeypair],
      {
        commitment: "confirmed",
        skipPreflight: true,
      }
    );
    return sig;
  } catch (e) {
    console.error("Failed to mint compressed NFT", e);
    throw e;
  }
};

export const getCompressedNftId = async (
  treeKeypair: Keypair,
  leafIndex: number
) => {
  const node = new BN.BN(leafIndex);
  const [assetId] = await PublicKey.findProgramAddress(
    [
      Buffer.from("asset", "utf8"),
      treeKeypair.publicKey.toBuffer(),
      Uint8Array.from(node.toArray("le", 8)),
    ],
    BUBBLEGUM_PROGRAM_ID
  );
  return assetId;
};

export const getCompressedNftId2 = async (
  tree: PublicKey,
  leafIndex: number
) => {
  const node = new BN.BN(leafIndex);
  const [assetId] = await PublicKey.findProgramAddress(
    [
      Buffer.from("asset", "utf8"),
      tree.toBuffer(),
      Uint8Array.from(node.toArray("le", 8)),
    ],
    BUBBLEGUM_PROGRAM_ID
  );
  return assetId;
};

export const transferAsset = async (
  connectionWrapper: WrappedConnection,
  owner: Keypair,
  newOwner: Keypair,
  assetId: string
) => {
  console.log(
    `Transfering asset ${assetId} from ${owner.publicKey.toBase58()} to ${newOwner.publicKey.toBase58()}. 
    This will depend on indexer api calls to fetch the necessary data.`
  );
  let assetProof = await connectionWrapper.getAssetProof(assetId);
  if (!assetProof?.proof || assetProof.proof.length === 0) {
    throw new Error("Proof is empty");
  }
  let proofPath = assetProof.proof.map((node: string) => ({
    pubkey: new PublicKey(node),
    isSigner: false,
    isWritable: false,
  }));
  console.log("Successfully got proof path from RPC.", assetProof);

  const rpcAsset = await connectionWrapper.getAsset(assetId);
  console.log(
    "Successfully got asset from RPC. Current owner: " +
      rpcAsset.ownership.owner,
    rpcAsset
  );
  if (rpcAsset.ownership.owner !== owner.publicKey.toBase58()) {
    throw new Error(
      `NFT is not owned by the expected owner. Expected ${owner.publicKey.toBase58()} but got ${
        rpcAsset.ownership.owner
      }.`
    );
  }

  const leafNonce = rpcAsset.compression.leaf_id;
  console.log("nonce is", leafNonce);

  const treeAuthority = await getBubblegumAuthorityPDA(
    new PublicKey(assetProof.tree_id)
  );
  const leafDelegate = rpcAsset.ownership.delegate
    ? new PublicKey(rpcAsset.ownership.delegate)
    : new PublicKey(rpcAsset.ownership.owner);
  let transferIx = createTransferInstruction(
    {
      treeAuthority,
      leafOwner: new PublicKey(rpcAsset.ownership.owner),
      leafDelegate: leafDelegate,
      newLeafOwner: newOwner.publicKey,
      merkleTree: new PublicKey(assetProof.tree_id),
      logWrapper: SPL_NOOP_PROGRAM_ID,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      anchorRemainingAccounts: proofPath,
    },
    {
      root: bufferToArray(bs58.decode(assetProof.root)),
      dataHash: bufferToArray(
        bs58.decode(rpcAsset.compression.data_hash.trim())
      ),
      creatorHash: bufferToArray(
        bs58.decode(rpcAsset.compression.creator_hash.trim())
      ),
      nonce: leafNonce,
      index: leafNonce,
    }
  );
  const tx = new Transaction().add(transferIx);
  tx.feePayer = owner.publicKey;
  try {
    const sig = await sendAndConfirmTransaction(
      connectionWrapper,
      tx,
      [owner],
      {
        commitment: "confirmed",
        skipPreflight: true,
      }
    );
    return sig;
  } catch (e) {
    console.error("Failed to transfer compressed asset", e);
    throw e;
  }
};

const redeemAsset = async (
  connectionWrapper: WrappedConnection,
  payer?: Keypair,
  assetId?: string
) => {
  console.log("redeem");
  let assetProof = await connectionWrapper.getAssetProof(assetId);
  const rpcAsset = await connectionWrapper.getAsset(assetId);
  const leafNonce = rpcAsset.compression.leaf_id;
  const voucher = await getVoucherPDA(
    new PublicKey(assetProof.tree_id),
    leafNonce
  );
  const treeAuthority = await getBubblegumAuthorityPDA(
    new PublicKey(assetProof.tree_id)
  );
  const leafDelegate = rpcAsset.ownership.delegate
    ? new PublicKey(rpcAsset.ownership.delegate)
    : new PublicKey(rpcAsset.ownership.owner);

  let proofPath = assetProof.proof.map((node: string) => ({
    pubkey: new PublicKey(node),
    isSigner: false,
    isWritable: false,
  }));
  console.log("Successfully got proof path from RPC.", assetProof);

  const redeemIx = createRedeemInstruction(
    {
      treeAuthority,
      leafOwner: new PublicKey(rpcAsset.ownership.owner),
      leafDelegate,
      merkleTree: new PublicKey(assetProof.tree_id),
      voucher,
      logWrapper: SPL_NOOP_PROGRAM_ID,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      anchorRemainingAccounts: proofPath,
    },
    {
      root: bufferToArray(bs58.decode(assetProof.root)),
      dataHash: bufferToArray(
        bs58.decode(rpcAsset.compression.data_hash.trim())
      ),
      creatorHash: bufferToArray(
        bs58.decode(rpcAsset.compression.creator_hash.trim())
      ),
      nonce: leafNonce,
      index: leafNonce,
    }
  );
  const _payer = payer ? payer : connectionWrapper.provider.wallet;
  return await execute(
    connectionWrapper.provider,
    [redeemIx],
    [_payer as Signer],
    true
  );
};

const sleep = async (ms: any) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const mapProof = (assetProof: { proof: string[] }): AccountMeta[] => {
  if (!assetProof.proof || assetProof.proof.length === 0) {
    throw new Error("Proof is empty");
  }
  return assetProof.proof.map((node) => ({
    pubkey: new PublicKey(node),
    isSigner: false,
    isWritable: false,
  }));
};

export async function decompressAsset(
  connectionWrapper: WrappedConnection,
  canopyHeight: number | undefined,
  payer: Keypair,
  assetId: string
) {
  console.log("decompress ", assetId);
  let assetProof = await connectionWrapper.getAssetProof(assetId);
  // let proofPath = mapProof(assetProof);

  let proofPath = assetProof.proof.map((node: string) => ({
    pubkey: new PublicKey(node),
    isSigner: false,
    isWritable: false,
  }));

  const rpcAsset = await connectionWrapper.getAsset(assetId);
  const leafNonce = rpcAsset.compression.leaf_id;
  const voucher = await getVoucherPDA(
    new PublicKey(assetProof.tree_id),
    leafNonce
  );

  console.log("proof path", proofPath.length);

  console.log("mint is", JSON.stringify(rpcAsset.id));

  const sig = await redeemAsset(connectionWrapper, payer, assetId);
  console.log("✅ redemption done", sig);

  let [assetPDA] = await PublicKey.findProgramAddress(
    [
      Buffer.from("asset"),
      new PublicKey(assetProof.tree_id).toBuffer(),
      Uint8Array.from(new BN(leafNonce).toArray("le", 8)),
    ],
    BUBBLEGUM_PROGRAM_ID
  );
  console.log("asset pda", assetPDA);
  const [mintAuthority] = await PublicKey.findProgramAddress(
    [assetPDA.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  );

  sleep(20000);
  const assetAgain = await connectionWrapper.getAsset(rpcAsset.id);

  console.log(1);

  const metadata: MetadataArgs = {
    name: rpcAsset.content.metadata.name,
    symbol: rpcAsset.content.metadata.symbol,
    uri: rpcAsset.content.json_uri,
    sellerFeeBasisPoints: rpcAsset.royalty.basis_points,
    primarySaleHappened: rpcAsset.royalty.primary_sale_happened,
    isMutable: rpcAsset.mutable,
    editionNonce: rpcAsset.supply.edition_nonce,
    tokenStandard: TokenStandard.Fungible, //TODO
    // collection: rpcAsset.grouping, //TODO
    collection: null,
    uses: rpcAsset.uses,
    tokenProgramVersion: TokenProgramVersion.Original,
    creators: rpcAsset.creators,
  };

  console.log(2, metadata);

  const decompressIx = createDecompressV1Instruction(
    {
      voucher: voucher,
      leafOwner: new PublicKey(assetAgain.ownership.owner),
      tokenAccount: await Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        new PublicKey(assetAgain.id),
        new PublicKey(assetAgain.ownership.owner)
      ),
      mint: new PublicKey(assetAgain.id),
      mintAuthority: mintAuthority,
      metadata: await getMetadata(new PublicKey(assetAgain.id)),
      masterEdition: await getMasterEdition(new PublicKey(assetAgain.id)),
      sysvarRent: SYSVAR_RENT_PUBKEY,
      tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      logWrapper: SPL_NOOP_PROGRAM_ID,
      anchorRemainingAccounts: proofPath.slice(
        0,
        proofPath.length - (!!canopyHeight ? canopyHeight : 0)
      ),
    },
    {
      // this can be grabbed onChain by using the metadataArgsBeet.deserialize
      // currently there is an error inside beet program while using it
      metadata,
    }
  );

  console.log(3);

  const _payer = payer ? payer : connectionWrapper.provider.wallet;
  const sig2 = await execute(
    connectionWrapper.provider,
    [decompressIx],
    [_payer as Signer],
    true
  );
  console.log("✅ decompression done", sig2);
}

//redemption 3NSp2Sbssb8FebGf5TNkzwTaj6X2b1Dohw1uzc9zDSCz5tEZ5dPEJ4xUygdoYK4gHfYtSeGjuM3VgJ9UsWWfqqv9
//decompression 45xniqUeMu12dBznymntJf2DNSJDRA5ZuBhh1b6x7d6NXCzNGbqytEMCaqfjpEMXLXd6oqQciDqCVqKoqvbdtTCr
