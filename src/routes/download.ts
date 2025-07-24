import { IRequest, status, json } from 'itty-router'
import { generateSignature, decrypt } from '../utils'

import { CacheManager } from '../utils/cache-manager'

export const download = async ({ headers, cf, urlHASH, query }: IRequest, env: Env, ctx: ExecutionContext) => {
    // get signature from query and check if it exists
    const signature = query?.sig
    if (!signature) {
        return status(400)
    }

    // make sure signature is a string
    if (typeof signature !== 'string') {
        return status(404)
    }

    // get user IP address
    const userIP = headers.get('CF-Connecting-IP') ||
        headers.get('x-forwarded-for')?.split(',')[0] ||
        headers.get('x-real-ip') ||
        headers.get('remote-addr') ||
        '77.96.243.165'

    // generate local signature and compare with the one from the query
    const localSignature = await generateSignature(userIP, env.SECRET)
    if (signature !== localSignature) {
        return status(405)
    }

    const cacheManager = new CacheManager(ctx)

    // http://127.0.0.1:8787/download/16BNzFaCVzpjWSkeZjLjDuwxbQRkYGFCUA5XLkngSkdMzUM8BoCEZfP2sqPN0eZBzJIpiicq5ozVx4QIf6gllRhkOoRZ6bVEVHp5f-MnDhY18PEfsl5iqZKoTx4bAY2rTm0E0lcd5EHIe0ee1Vyz3Av-uzbpHDG2QzIXymz8oxL1zy3-eVHmxn7jYRQ6UdeeIKF-KWo_AWAB11sN7LeE7AIuCXovVLE2Hg5x5abO-Iwc7cj41OzWTKx0HMJPiMMPtLsaRFNifMl4psW7lGxadnTnznF5DTbL-W9fsTwZpijIhwX8xo_jgg30dU2B4Kz7b9TAbTaXprCps4pZNGTQpWrMyqyBWf3Qr8wWf4GExwtX-6UwwKh9G4FbHC1CvOyG4C8wJcmW4JK46dtVRQVUzEoG_9ygRck3cub4nxiXzDoEnKxnbbfl4X_p4dU5_veYyJm1Iog2gjqf0Ad1bEKJlAqNst5VIfWAklOOYgcDlWvFxRWIBqsjfgck1KWZNSZG23UgmkB5yYeH356YJligtOT55dWeOD5DxFDZJRgpLe3zfD8oF3hJwUrwQ5JtP4fE0EX3gneHfvH-CbfQxoxbtJwSLuNAxzNLEPUkf-0yvBk?sig=EdwKRMgwZx4OJCEnbyADQk52LDsk3HYTH6FZeJZ0uJg

    try {
        // Decrypt the URL
        const decodedURL = await decrypt(urlHASH.replace(/-/g, '+').replace(/_/g, '/'), env.SECRET, env.IV_SECRET)
        const url = new URL(decodedURL)

        // return json({
        //     url: url.pathname,
        //     decodedURL
        // })

        const cached = await cacheManager.get(url.pathname)
        if (cached) {
            return cached
        }

        // fetch the file from the URL b
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers
        })

        if (!response.ok) {
            return status(500)
        }

        const contentDisposition = response.headers.get('content-disposition')
        const headersObject = Object.fromEntries(response.headers.entries())

        if (!contentDisposition?.includes('filename')) {
            const filename = url.pathname.split('/').pop()
            headersObject['content-disposition'] = `attachment; filename="${filename}"`
        }

        // Clone response before consuming the body
        const responseClone = response.clone()

        const finalResponse = new Response(response.body, {
            status: response.status,
            headers: new Headers({
                ...headersObject,
                'Cache-Control': 'public, max-age=31536000, immutable',
            })
        })

        // Cache the response for 7 days
        await cacheManager.set(url.pathname, responseClone, 604800)

        return finalResponse
    } catch (error) {
        if (error instanceof TypeError && error.message.includes('fetch')) {
            return status(502) // Bad Gateway for fetch errors
        }
        return status(503)
    }
}
