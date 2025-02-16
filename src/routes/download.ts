import { IRequest, status } from 'itty-router'
import { generateSignature, decrypt } from '../utils'

export const download = async ({ headers, cf, urlHASH, query }: IRequest, env: Env) => {
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
        '127.0.0.1'

    // generate local signature and compare with the one from the query
    const localSignature = await generateSignature(userIP, env.SECRET)
    if (signature !== localSignature) {
        return status(405)
    }

    try {
        // decrypt the URL
        const decodedURL = await decrypt(urlHASH.replace(/-/g, '+').replace(/_/g, '/'), env.SECRET, env.IV_SECRET)
        const url = new URL(decodedURL)

        // get range headers and any other headers needed for resume downloads from the request
        const range = headers.get('Range')
        const _headers = new Headers({
            'User-Agent': headers.get('User-Agent') || '',
            'Referer': headers.get('Referer') || '',
            'Accept-Encoding': 'identity',
            // 'X-Forwarded-For': userIP,
            // 'X-Real-IP': userIP
        })

        if (range) {
            _headers.set('Range', range)
        }

        // fetch the file from the URL
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: _headers
        })

        if (!response.ok) {
            return status(500)
        }

        console.log(JSON.stringify(Object.fromEntries(response.headers)))

        return new Response(response.body, {
            status: response.status,
            headers: {
                ...Object.fromEntries(response.headers),
                'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
                'Content-Disposition': response.headers.get('Content-Disposition') || 'attachment',
                'Content-Length': response.headers.get('Content-Length') || '',
                'Cache-Control': response.headers.get('Cache-Control') || 'public, max-age=3600',
                'Expires': response.headers.get('Expires') || '',
                'Last-Modified': response.headers.get('Last-Modified') || '',
                'ETag': response.headers.get('ETag') || '',
                'Content-Range': response.headers.get('Content-Range') || '',
                'Accept-Ranges': response.headers.get('Accept-Ranges') || 'bytes'
            }
        })
    } catch (error) {
        console.error(error)
        return status(503)
    }
}
