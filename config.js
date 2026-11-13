/* Projet Supabase « apres-le-bip » (clé publique : sans danger dans le code du site) */
const CFG = {
  url: 'https://vvdrkshywvolajjblxrg.supabase.co',
  key: 'sb_publishable_2G0JoQ1tdpPmY63YukloJQ_eNBA8KNS',
  maxVideoMB: 50,   // doit correspondre à la limite du serveur (offre gratuite Supabase : 50 Mo par fichier)
  maxPhotoMB: 15,
  // Documents juridiques : renseigner cgvUrl: 'cgv.html' une fois les conditions de vente publiées (affiche le lien et la case de renonciation à la rétractation)
  legal: { cgvUrl: '' },
  // Boutique : laissez vide ce qui n'est pas encore prêt (le bouton correspondant n'apparaît pas)
  shop: {
    onlinePay: false,       // passer à true quand Stripe est branché : active acheter.html et les boutons « Payer en ligne »
    etsyShopUrl: 'https://www.etsy.com/shop/MaitreDuJeu',   // votre boutique Etsy (lien affiché sur le site)
    etsyUrl: '',            // adresse de l'annonce Etsy de CE produit (quand elle existera : le bouton « Acheter sur Etsy » apparaît)
    payUrlStandard: 'acheter.html?f=standard',     // page de paiement en ligne (n'apparaît que si onlinePay est à true)
    payUrlCapsule: 'acheter.html?f=capsule',
    priceStandard: '29,90 €',                                  // prix affiché (formule essentielle)
    priceStandardNote: 'Prix de lancement · puis 39,90 €',     // petite mention sous le prix (laisser vide si inutile)
    priceCapsule: '49,90 €',                                   // prix affiché (formule avec time capsule)
    priceCapsuleNote: 'Prix de lancement · puis 59,90 €',
    etsyUrlUpgrade: '',     // annonce Etsy « ajouter la time capsule » (quand elle existera)
    payUrlUpgrade: 'acheter.html?f=upgrade',
    priceUpgrade: '24,90 €' // prix affiché dans l'application
  }
};
