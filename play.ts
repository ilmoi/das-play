import {
  decompressAsset,
  getCompressedNftId,
  getCompressedNftId2,
  initCollection,
  mintCompressedNft,
  transferAsset,
} from "./utils";

const axios = require("axios");
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

import {
  getConcurrentMerkleTreeAccountSize,
  createVerifyLeafIx,
  ConcurrentMerkleTreeAccount,
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  SPL_NOOP_PROGRAM_ID,
  ValidDepthSizePair,
} from "@solana/spl-account-compression";

import {
  createCreateTreeInstruction,
  createMintV1Instruction,
  MetadataArgs,
  PROGRAM_ID as BUBBLEGUM_PROGRAM_ID,
  TokenProgramVersion,
  TokenStandard,
  Creator,
  createTransferInstruction,
} from "@metaplex-foundation/mpl-bubblegum";
import {
  getLeafAssetId,
  computeCompressedNFTHash,
} from "@metaplex-foundation/mpl-bubblegum";
import { BN } from "bn.js";
import { WrappedConnection } from "./wrappedConnection";

// TODO: replace with your own
const url = `https://api.mainnet-beta.solana.com`;

const getAssets = async () => {
  const assetId = "4TqYFSJYj7kC1peJgve1jns2A1hStw9S4BdryJFyrNWH";
  const { data } = await axios.post(url, {
    jsonrpc: "2.0",
    id: "my-id",
    method: "getAsset",
    params: [assetId],
  });
  console.log("assets: ", data.result);
};

const getAssetsByOwner = async () => {
  const owner = "93eNXwBovuytUL7pzP3WH6M987n5u27CVRgjQFGfvHhw";
  const sortBy = {
    sortBy: "created",
    sortDirection: "asc",
  };
  const limit = 50;
  const page = 1;
  const before = "";
  const after = "";
  const { data } = await axios.post(url, {
    jsonrpc: "2.0",
    id: "my-id",
    method: "getAssetsByOwner",
    params: [owner, sortBy, limit, page, before, after],
  });
  console.log("assets: ", data.result);
};

// getAssetsByOwner();
// getAssets();

function keypairFromSeed(seed: string) {
  const expandedSeed = Uint8Array.from(Buffer.from(`${seed}`));
  return Keypair.fromSeed(expandedSeed.slice(0, 32));
}

function makeCompressedNFT(
  name: string,
  symbol: string,
  creators: Creator[] = []
): MetadataArgs {
  return {
    name: name,
    symbol: symbol,
    uri: "https://metaplex.com",
    creators,
    editionNonce: 0,
    tokenProgramVersion: TokenProgramVersion.Original,
    tokenStandard: TokenStandard.Fungible,
    uses: null,
    collection: null,
    primarySaleHappened: false,
    sellerFeeBasisPoints: 0,
    isMutable: false,
  };
}

async function setupTreeWithCompressedNFT(
  connection: Connection,
  payerKeypair: Keypair,
  compressedNFT: MetadataArgs,
  depthSizePair: ValidDepthSizePair = {
    maxDepth: 14,
    maxBufferSize: 64,
  }
): Promise<{
  merkleTree: PublicKey;
}> {
  const payer = payerKeypair.publicKey;

  const merkleTreeKeypair = Keypair.generate();
  const merkleTree = merkleTreeKeypair.publicKey;
  const space = getConcurrentMerkleTreeAccountSize(
    depthSizePair.maxDepth,
    depthSizePair.maxBufferSize
  );
  const allocTreeIx = SystemProgram.createAccount({
    fromPubkey: payer,
    newAccountPubkey: merkleTree,
    lamports: await connection.getMinimumBalanceForRentExemption(space),
    space: space,
    programId: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  });
  const [treeAuthority, _bump] = await PublicKey.findProgramAddress(
    [merkleTree.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  );
  const createTreeIx = createCreateTreeInstruction(
    {
      merkleTree,
      treeAuthority,
      treeCreator: payer,
      payer,
      logWrapper: SPL_NOOP_PROGRAM_ID,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    },
    {
      maxBufferSize: depthSizePair.maxBufferSize,
      maxDepth: depthSizePair.maxDepth,
      public: false,
    },
    BUBBLEGUM_PROGRAM_ID
  );

  const mintIx = createMintV1Instruction(
    {
      merkleTree,
      treeAuthority,
      treeDelegate: payer,
      payer,
      leafDelegate: payer,
      leafOwner: payer,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      logWrapper: SPL_NOOP_PROGRAM_ID,
    },
    {
      message: compressedNFT,
    }
  );

  const tx = new Transaction().add(allocTreeIx).add(createTreeIx).add(mintIx);
  tx.feePayer = payer;
  await sendAndConfirmTransaction(
    connection,
    tx,
    [merkleTreeKeypair, payerKeypair],
    {
      commitment: "confirmed",
      skipPreflight: true,
    }
  );

  console.log("✅ tree created + minted", merkleTree);

  return {
    merkleTree,
  };
}

async function mintOnly(
  connection: Connection,
  payerKeypair: Keypair,
  merkleTree: PublicKey,
  compressedNFT: MetadataArgs
) {
  const payer = payerKeypair.publicKey;

  const [treeAuthority, _bump] = await PublicKey.findProgramAddress(
    [merkleTree.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  );
  const mintIx = createMintV1Instruction(
    {
      merkleTree,
      treeAuthority,
      treeDelegate: payer,
      payer,
      leafDelegate: payer,
      leafOwner: payer,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
      logWrapper: SPL_NOOP_PROGRAM_ID,
    },
    {
      message: compressedNFT,
    }
  );

  const tx = new Transaction().add(mintIx);
  tx.feePayer = payer;
  const sig = await sendAndConfirmTransaction(connection, tx, [payerKeypair], {
    commitment: "confirmed",
    skipPreflight: true,
  });

  console.log("✅ minted", sig);

  return {
    merkleTree,
  };
}

// tx to create bgum and mit the asset
// https://solscan.io/tx/5SuBQaMq5qXQe7Ly2tXtp28eH7LfKBgopxRHd5PGp3MpX4mUJw1uVFeZcrFmPn3bowxN7hxLeSNDUH4Extqvvmgj

// mint one more
// https://xray.helius.xyz/tx/5afXv4uJF69JRTD8pRjpdb9WdDQZLxjoJYQW7XD3a3by5ALZ8XHNmxJBFt669xvRJ2NGFdx5hCPF4h7R2gJ9vpjz
//"assetId": "FxcuXjwSmQPqrdbrZxgcaT5Cuzsv8FVVuVLoRmvQY3sS",

(async () => {
  const connection = new Connection(url);
  // const payerKeypair = keypairFromSeed(
  //   "metaplex-test09870987098709870987009709870987098709870987"
  // );
  const payerKeypair = Keypair.fromSecretKey(
    Uint8Array.from(require("/Users/ilmoi/.config/solana/id.json"))
  );
  const payerKeypair2 = Keypair.fromSecretKey(
    Uint8Array.from(require("/Users/ilmoi/.config/solana/play.json"))
  );
  console.log("payer", payerKeypair);

  const compressedNFT: MetadataArgs = {
    name: "Test Compressed NFT",
    symbol: "TST",
    uri: "https://v6nul6vaqrzhjm7qkcpbtbqcxmhwuzvcw2coxx2wali6sbxu634a.arweave.net/r5tF-qCEcnSz8FCeGYYCuw9qZqK2hOvfVgLR6Qb09vg",
    creators: [],
    editionNonce: 0,
    tokenProgramVersion: TokenProgramVersion.Original,
    tokenStandard: TokenStandard.Fungible,
    uses: null,
    collection: null,
    primarySaleHappened: false,
    sellerFeeBasisPoints: 0,
    isMutable: false,
  };
  // await setupTreeWithCompressedNFT(connection, payerKeypair, compressedNFT, {
  //   maxDepth: 14,
  //   maxBufferSize: 64,
  // });

  const merkleTree = new PublicKey(
    "ACenV9A6DtVwsMaaMCiA8VKpAw2oiZcSUd9c9UrarsLn"
  );
  // await mintOnly(connection, payerKeypair, merkleTree, compressedNFT);

  const payer = payerKeypair.publicKey;

  const [treeAuthority, _bump] = await PublicKey.findProgramAddress(
    [merkleTree.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  );

  const connectionWrapper = new WrappedConnection(payerKeypair, url);

  // --------------------------------------- transfer

  // Get the NFT mint ID from the merkle tree.
  const treeAccount = await ConcurrentMerkleTreeAccount.fromAccountAddress(
    connection,
    merkleTree
  );
  // Get the most rightmost leaf index, which will be the most recently minted compressed NFT.
  // Alternatively you can keep a counter that is incremented on each mint.
  const leafIndex = treeAccount.tree.rightMostPath.index - 1;
  const assetId = await getCompressedNftId2(merkleTree, leafIndex);
  console.log("Last asset id: " + assetId);
  console.log(await connectionWrapper.getAsset(assetId));

  // console.log("\n===Transfer===");
  // console.log("Transfer to new wallet.");
  // const sig = await transferAsset(
  //   connectionWrapper,
  //   payerKeypair2,
  //   payerKeypair,
  //   assetId.toBase58()
  // );
  // console.log(
  //   "Successfully transferred nft to wallet: " +
  //     payerKeypair.publicKey.toBase58()
  // );
  // console.log("✅ done", sig);

  // --------------------------------------- decompress

  // await decompressAsset(
  //   connectionWrapper,
  //   undefined,
  //   payerKeypair,
  //   assetId.toBase58()
  // );

  // --------------------------------------- mint to a collection (verified)

  await initCollection(connectionWrapper, payerKeypair2);

  // CSUA owned collection
  // const c = new PublicKey("9rvBMvEXe19A54sEyeFfi9QDBh7rSNEniLUffHtTEc8v");

  // DNC owned collection
  const c = new PublicKey("4LxBxBehFYqFJ4xZMcNgQM7B1y9fgpSXjKFfVVUXL7qN");

  const sig = await mintCompressedNft(
    connectionWrapper,
    compressedNFT,
    payerKeypair,
    merkleTree,
    c
  );
  console.log("minted", sig);
})();
