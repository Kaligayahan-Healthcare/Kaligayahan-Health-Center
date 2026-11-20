# Privacy compliance checklist (Data Privacy Act of 2012, RA 10173)

The website collects personal and health-related information (names, ages, mobile numbers, emails,
addresses, priority status such as pregnancy or disability, and the reason for a check-up). Under the
Data Privacy Act, health information is **sensitive personal information**. The barangay health center
is the **personal information controller (PIC)**.

This list was prepared to help. It is not legal advice. Please confirm each item with the **National Privacy
Commission (NPC, privacy.gov.ph)** or the city legal / ICT office before launch.

## Before launch

| # | What | Who | Done |
|---|---|---|---|
| 1 | **Appoint a Data Protection Officer (DPO)**. Use the letter below; the DPO can be an existing staff member. | Barangay captain | ☐ |
| 2 | **Register with the NPC** (NPC Registration System, `npcregistration.privacy.gov.ph`). Check whether registration is required for your case: it depends on the number of people whose sensitive information is processed and on the size of the office. When in doubt, register; the DPO and the processing system are registered online. | DPO | ☐ |
| 3 | **Privacy Impact Assessment (PIA)** of the online queue. Use NPC Advisory 2017-03 as the guide. The "How the data is protected" table in `backend/README.md` describes the safeguards. | DPO | ☐ |
| 4 | **Privacy Manual**: the internal rules (who may see what, how long data is kept, how requests are handled). The retention rules are below. | DPO | ☐ |
| 5 | **Review the Privacy Notice page** on the website (`#privacy`): the DPO's name and contact, and the retention periods. Change the text in `website/app.js` (function `viewPrivacy`) if anything differs. | DPO | ☐ |
| 6 | **Staff confidentiality**: each staff account holder signs a confidentiality undertaking, then gets their own account (never share accounts). | DPO | ☐ |
| 7 | **Security of the server PC**: double-click `Check server PC security.bat` and fix every "FIX" (Windows password, disk encryption, screen lock). | Admin | ☐ |
| 8 | **Recovery kit** copied to a USB drive or printed, and kept in a locked drawer. | Admin | ☐ |
| 9 | **Breach procedure** (below) printed and known to the staff. | DPO | ☐ |
| 10 | **If the database is on Supabase** (see SUPABASE.md): list Supabase as a **personal information processor** in the PIA, the Privacy Manual and the NPC registration. Note that the data is stored in **Tokyo, Japan** (Supabase region Northeast Asia, `ap-northeast-1`) (outside the Philippines) but encrypted before it leaves the health center, and that Supabase never has the key. Sign Supabase's **Data Processing Agreement** (DPA). The website's Privacy Notice already says this automatically when Supabase is in use. | DPO | ☐ |

## What the system already does

- Collects only what the queue needs; ID numbers and diagnoses are not asked for.
- Requires a ticked consent box with a link to the Privacy Notice.
- Encrypts names, numbers, emails, addresses and codes in the database and in the backups.
- Gives each staff member their own account, limits what each role can see, and records every staff action in a tamper-evident log.
- **Retention:** personal details are removed after **90 days**, records deleted after **400 days**, messages after **60 days**. Backups are kept for at most about **90 days**. The Excel file lists only the last 90 days in detail.
- Email updates need the person to confirm their address first.

## Data subject requests (see, correct, delete)

People may ask at the triage desk or through the hotline. The DPO checks their identity in person, then:

- **To see their record:** an administrator looks it up (Appointments, or the Excel workbook) and shows or prints it.
- **To correct it:** edit the record in the staff portal. The change is logged.
- **To delete it:** remove the ticket or request in the staff portal, or wait for the automatic 90-day removal. Answer within the period the NPC sets.

## Breach procedure (keep printed)

1. **Contain:** unplug the computer from the network if it may be compromised. Change all staff passwords (admin: `reset_password.py`).
2. **Record:** what happened, when, which records. The activity log in Settings helps; download a copy.
3. **Notify:** if sensitive personal information may have been obtained by someone unauthorised and could cause serious harm, the PIC must notify the **NPC and the affected people within 72 hours** of knowing about it (NPC Circular 16-03). The DPO decides, with the barangay captain.
4. **Restore:** use `restore_backup.py` with a backup from before the incident, if needed.

## DPO appointment letter (template)

> **Office of the Punong Barangay, Barangay Kaligayahan, Quezon City**
>
> **Designation of Data Protection Officer**
>
> In compliance with Republic Act No. 10173 (Data Privacy Act of 2012) and its Implementing Rules and Regulations,
> **[Full name]**, **[position]**, is hereby designated as the Data Protection Officer of the Barangay Kaligayahan
> Health Center, including its Availability Tracking System (online queue website), effective **[date]**.
>
> The DPO shall monitor compliance with the Data Privacy Act; act as the contact person of the National Privacy
> Commission and of data subjects; conduct privacy impact assessments; handle data subject requests and personal
> data breaches; and advise the health center on data protection.
>
> Contact details of the DPO for the public: **[email] / [phone]**.
>
> Signed: **[Punong Barangay]**, **[date]**
