/**
 * Generate a signature for the given IP address using the given secret.
 * @param ip
 * @param secret
 */
export async function generateSignature(ip: string, secret: string) {
    const encoder = new TextEncoder()

    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign']
    )

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(ip))
    return btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

/**
 * Generate a key for the given secret.
 * @param secret
 */
export const getKey = async (secret: string) => {
    const keyBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
    const truncatedKeyBuffer = keyBuffer.slice(0, 16)

    return await crypto.subtle.importKey(
        'raw',
        truncatedKeyBuffer,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
    )
}

/**
 * Encrypt the given content using the given secret and iv_secret.
 * @param content
 * @param secret
 * @param iv_secret
 */
export const decrypt = async (content: string, secret: string, iv_secret: string) => {
    console.log('decrypting', content)

    const key = await getKey(secret)
    const iv = new TextEncoder().encode(iv_secret).slice(0, 16)

    const decoded = Uint8Array.from(atob(content), c => c.charCodeAt(0))
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-CBC", iv },
        key,
        decoded
    )

    return new TextDecoder().decode(decrypted)
}
