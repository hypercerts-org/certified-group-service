import { randomBytes } from 'node:crypto'
import type { Express } from 'express'
import { AtpAgent } from '@atproto/api'
import { ensureValidDid } from '@atproto/syntax'
import { InvalidRequestError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'
import { ConflictError } from '../../errors.js'
import { encrypt } from '../../pds/credentials.js'

export default function (app: Express, ctx: AppContext) {
  app.post('/xrpc/app.certified.group.register', async (req, res, next) => {
    try {
      const { handle, ownerDid, email } = req.body

      // Validate inputs
      if (!handle || !ownerDid) {
        throw new InvalidRequestError('Missing required fields: handle, ownerDid')
      }
      try {
        ensureValidDid(ownerDid)
      } catch {
        throw new InvalidRequestError('Invalid ownerDid')
      }
      if (!/^[a-zA-Z0-9-]+$/.test(handle)) {
        throw new InvalidRequestError('Invalid handle: must be alphanumeric with hyphens')
      }

      const pdsUrl = ctx.config.groupPdsUrl
      const pdsHostname = new URL(pdsUrl).hostname

      // Build the full handle: {handle}.{pdsHostname}
      const fullHandle = `${handle}.${pdsHostname}`

      // Use caller-provided email or generate a placeholder
      const accountEmail = email || `${handle}@group.${pdsHostname}`

      // Generate a random password for the account
      const accountPassword = randomBytes(24).toString('base64url')

      // Create the group account on the group's PDS
      const agent = new AtpAgent({ service: pdsUrl })
      let createRes
      try {
        createRes = await agent.com.atproto.server.createAccount({
          email: accountEmail,
          handle: fullHandle,
          password: accountPassword,
          ...(ctx.config.groupPdsInviteCode && { inviteCode: ctx.config.groupPdsInviteCode }),
        })
      } catch (err: any) {
        if (
          err?.status === 400 &&
          (err?.error === 'HandleNotAvailable' ||
            err?.message?.includes('Handle already taken'))
        ) {
          throw new ConflictError('Handle already taken on the PDS', 'HandleNotAvailable')
        }
        throw err
      }

      const groupDid = createRes.data.did

      // Resume the session so the agent is authenticated for subsequent calls
      await agent.resumeSession({
        did: createRes.data.did,
        handle: createRes.data.handle,
        accessJwt: createRes.data.accessJwt,
        refreshJwt: createRes.data.refreshJwt,
        active: true,
      })

      // Register service endpoint in group's DID document
      const { data: recommended } = await agent.com.atproto.identity.getRecommendedDidCredentials()

      let operation
      try {
        const signed = await agent.com.atproto.identity.signPlcOperation({
          ...recommended,
          services: {
            ...recommended.services as Record<string, unknown>,
            certified_group: {
              type: 'CertifiedGroupService',
              endpoint: ctx.config.serviceUrl,
            },
          },
        })
        operation = signed.data.operation
      } catch (err: any) {
        if (err?.message?.includes('email confirmation')) {
          throw new InvalidRequestError(
            'The group PDS requires email confirmation before updating the DID document. ' +
            'Provide a valid, confirmable email address when registering the group, or ' +
            'disable email confirmation on the group PDS.',
          )
        }
        throw err
      }

      await agent.com.atproto.identity.submitPlcOperation({ operation })

      // Create an app password for the group service to use
      const appPasswordRes = await agent.com.atproto.server.createAppPassword({
        name: 'group-service',
      })
      const appPassword = appPasswordRes.data.password

      // Encrypt and store
      const encryptionKey = Buffer.from(ctx.config.encryptionKey, 'hex')
      const encrypted = encrypt(appPassword, encryptionKey)
      try {
        await ctx.globalDb
          .insertInto('groups')
          .values({ did: groupDid, pds_url: pdsUrl, encrypted_app_password: encrypted })
          .execute()
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('UNIQUE constraint failed') || msg.includes('PRIMARY KEY constraint failed')) {
          throw new ConflictError('Group already registered', 'GroupAlreadyRegistered')
        }
        throw err
      }

      // Initialize per-group database and run migrations
      await ctx.groupDbs.migrateGroup(groupDid)

      // Seed owner
      const groupDb = ctx.groupDbs.get(groupDid)
      await groupDb
        .insertInto('group_members')
        .values({ member_did: ownerDid, role: 'owner', added_by: ownerDid })
        .execute()

      // Audit log the group creation
      await ctx.audit.log(groupDb, ownerDid, 'group.register', 'permitted', {
        handle: fullHandle,
      })

      res.json({
        groupDid,
        handle: fullHandle,
        accountPassword,
      })
    } catch (err) {
      next(err)
    }
  })
}
