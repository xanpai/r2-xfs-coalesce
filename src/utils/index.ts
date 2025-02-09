const SECRET = '5TxkrneszRLqNQww'
const IV_SECRET = '5eszHgb_hey_2024'

export async function generateSignature(ip: string) {
    const encoder = new TextEncoder()

    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign']
    )

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(ip))
    return btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}


export const getKey = async () => {
    const keyBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SECRET))
    const truncatedKeyBuffer = keyBuffer.slice(0, 16)

    return await crypto.subtle.importKey(
        'raw',
        truncatedKeyBuffer,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
    )
}

export const decrypt = async (content: string) => {
    console.log('decrypting', content)

    const key = await getKey()
    const iv = new TextEncoder().encode(IV_SECRET).slice(0, 16)

    const decoded = Uint8Array.from(atob(content), c => c.charCodeAt(0))
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-CBC", iv },
        key,
        decoded
    )

    return new TextDecoder().decode(decrypted)
}
