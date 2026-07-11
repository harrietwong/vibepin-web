const { createClient } = require("./pw_temp/node_modules/@supabase/supabase-js/dist/main/index.js");

const SUPA_URL = "https://jaxteelkecvlozdrdoog.supabase.co";
const SVC_KEY  = process.env.SUPA_SVC;

const admin = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } });

(async () => {
  try {
    const { data, error } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: "zhihuihuang321@gmail.com",
    });
    if (error) { console.error("ERR:", error.message); process.exit(1); }
    console.log("LINK:", data.properties.action_link);
  } catch(e) { console.error(e); process.exit(1); }
})();
