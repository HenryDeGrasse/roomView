import Foundation

/// Minimal writer for NumPy v1.0 `.npy` files. Supports 2-D float32 and uint8
/// arrays in C (row-major) order, which covers the depth and confidence maps we
/// export from ARKit.
public enum NumpyEncoder {
    public static func encodeFloat32(bytes: Data, width: Int, height: Int) -> Data {
        assert(bytes.count == width * height * MemoryLayout<Float32>.size, "float32 byte length mismatch")
        return encode(descriptor: "<f4", width: width, height: height, bytes: bytes)
    }

    public static func encodeUInt8(bytes: Data, width: Int, height: Int) -> Data {
        assert(bytes.count == width * height, "uint8 byte length mismatch")
        return encode(descriptor: "|u1", width: width, height: height, bytes: bytes)
    }

    private static func encode(descriptor: String, width: Int, height: Int, bytes: Data) -> Data {
        let magic = Data([0x93, 0x4E, 0x55, 0x4D, 0x50, 0x59])
        let major: UInt8 = 1
        let minor: UInt8 = 0
        let headerBody = "{'descr': '\(descriptor)', 'fortran_order': False, 'shape': (\(height), \(width)), }"
        let prefixLength = magic.count + 2 + 2
        let rawHeaderLength = prefixLength + headerBody.count + 1
        let paddedTotal = ((rawHeaderLength + 63) / 64) * 64
        let paddingCount = paddedTotal - prefixLength - headerBody.count - 1
        var headerAscii = headerBody
        headerAscii.append(String(repeating: " ", count: max(0, paddingCount)))
        headerAscii.append("\n")
        let headerData = Data(headerAscii.utf8)
        let headerLength = UInt16(headerData.count)

        var out = Data()
        out.append(magic)
        out.append(major)
        out.append(minor)
        out.append(UInt8(headerLength & 0xFF))
        out.append(UInt8((headerLength >> 8) & 0xFF))
        out.append(headerData)
        out.append(bytes)
        return out
    }
}
