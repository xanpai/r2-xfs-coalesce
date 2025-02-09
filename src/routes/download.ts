import { IRequest, json, status } from 'itty-router'
import { generateSignature, decrypt } from '../utils'

export const download = async ({ headers, cf, urlHASH, query }: IRequest) => {
    const signature = query?.sig
    if (!signature) {
        return status(404)
    }

    if (typeof signature !== 'string') {
        return status(404)
    }

    const userIP = headers.get('CF-Connecting-IP') ||
        headers.get('x-forwarded-for')?.split(',')[0] ||
        headers.get('x-real-ip') ||
        headers.get('remote-addr') ||
        '77.96.243.165'

    const localSignature = await generateSignature(userIP)
    if (signature !== localSignature) {
        return status(404)
    }

    const decodedURL = await decrypt(urlHASH.replace(/-/g, '+').replace(/_/g, '/'))
    const url = new URL(decodedURL)

    const response = await fetch(url.toString(), {
        method: 'GET'
    })

    return new Response(response.body, {
        status: response.status,
        headers: {
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
}
