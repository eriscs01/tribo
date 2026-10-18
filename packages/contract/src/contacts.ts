// Contact details and links shared by library people and vendors.
import * as z from 'zod';

const phone = z.string().trim().min(3).max(40);
const messenger = z.string().trim().min(1).max(200);
const email = z.email().max(254);

/** How to reach someone. Not sensitive: everyone who can see the row sees these. */
export const Contacts = z
  .strictObject({
    phone: phone.optional(),
    email: email.optional(),
    /** A messaging handle or profile link, e.g. a Messenger or WhatsApp name. */
    messenger: messenger.optional(),
  })
  .meta({ id: 'Contacts' });

export type Contacts = z.infer<typeof Contacts>;

/** A JSON Merge Patch of Contacts: a key set to null is removed. */
export const ContactsPatch = z
  .strictObject({
    phone: phone.nullable().optional(),
    email: email.nullable().optional(),
    messenger: messenger.nullable().optional(),
  })
  .meta({ id: 'ContactsPatch' });

export type ContactsPatch = z.infer<typeof ContactsPatch>;

/** Web links (a Facebook page, a booking site), http or https only. */
export const Links = z
  .array(z.url({ protocol: /^https?$/ }).max(2000))
  .max(20)
  .meta({ id: 'Links' });

export type Links = z.infer<typeof Links>;
