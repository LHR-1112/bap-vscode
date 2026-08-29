// Java 序列化协议常量（JDK ObjectStreamConstants）。

/** 流头：STREAM_MAGIC(0xACED) + STREAM_VERSION(5)。 */
export const STREAM_MAGIC = 0xaced;
export const STREAM_VERSION = 5;
export const STREAM_HEADER = Buffer.from([0xac, 0xed, 0x00, 0x05]);

// Wire type tags（ObjectStreamConstants.TC_*）。
export const TC_NULL = 0x70;
export const TC_REFERENCE = 0x71;
export const TC_CLASSDESC = 0x72;
export const TC_OBJECT = 0x73;
export const TC_STRING = 0x74;
export const TC_ARRAY = 0x75;
export const TC_CLASS = 0x76;
export const TC_BLOCKDATA = 0x77;
export const TC_ENDBLOCKDATA = 0x78;
export const TC_RESET = 0x79;
export const TC_BLOCKDATALONG = 0x7a;
export const TC_EXCEPTION = 0x7b;
export const TC_LONGSTRING = 0x7c;
export const TC_PROXYCLASSDESC = 0x7d;

// Class descriptor flags（ObjectStreamConstants.SC_*）。
export const SC_WRITE_METHOD = 0x01;
export const SC_SERIALIZABLE = 0x02;
export const SC_EXTERNALIZABLE = 0x04;
export const SC_BLOCK_DATA = 0x08;
export const SC_ENUM = 0x10;

/** 引用表起始 handle。 */
export const BASE_WIRE_HANDLE = 0x7e0000;

/** blockdata 写入 1024 字节时自动分块（BlockDataOutputStream 的 maxBlockSize）。 */
export const BLOCK_DATA_MAX = 1024;
