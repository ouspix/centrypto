"""Standalone figure of paired held-out target-ranking effects."""
import os
os.environ.setdefault('MPLCONFIGDIR','/mnt/c/Users/melli/.codex/research/centrypto/feature-ablation-2026-11-14/matplotlib')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.colors import TwoSlopeNorm
from matplotlib.patches import Rectangle
from four_common import *

def main():
    effects=json.loads((HERE/'classification-effects.json').read_text())
    roles=['long_entry','short_entry','long_exit','short_exit']
    titles=['Add optional group to core','Contribution within full model\n(full minus model without group)']
    labels={'price_shape':'Price shape','volume_detail':'Volume detail','sma_detail':'SMA detail','market_context':'BTC / ETH context','derivatives':'Derivatives','liquidity':'Liquidity','spot':'Spot market','clock':'Time of day','position_history':'Position history'}
    fig,axes=plt.subplots(1,2,figsize=(14.5,9.2),sharey=True)
    arrays=[]
    for context in ['add_to_core','full_minus_drop']:
        arrays.append(np.array([[r['roles'][role][context]['summary']['median']*100 for role in roles] for r in effects]))
    bound=max(1,float(max(np.abs(a).max() for a in arrays)));norm=TwoSlopeNorm(vmin=-bound,vcenter=0,vmax=bound)
    for ax,a,context,title in zip(axes,arrays,['add_to_core','full_minus_drop'],titles):
        im=ax.imshow(a,cmap='RdBu',norm=norm,aspect='auto')
        ax.set_title(title,fontsize=13,pad=14)
        ax.set_xticks(range(4),['Long\nentry','Short\nentry','Long\nexit','Short\nexit'])
        ax.set_yticks(range(len(effects)),[labels[r['group']] for r in effects])
        ax.tick_params(length=0,labelsize=11)
        for i,r in enumerate(effects):
            for j,role in enumerate(roles):
                if r['group']=='liquidity' or (r['group']=='position_history' and role.endswith('entry')):
                    ax.add_patch(Rectangle((j-.5,i-.5),1,1,facecolor='#eeeeee',edgecolor='white'))
                    label='No data' if r['group']=='liquidity' else 'Not used'
                    ax.text(j,i,label,ha='center',va='center',fontsize=9,color='#555555')
                else:
                    positive=r['roles'][role][context]['summary']['positive'];value=a[i,j]
                    color='white' if abs(value)>.55*bound else '#17212b'
                    ax.text(j,i,f'{value:+.2f} pp\n{positive}/3 positive',ha='center',va='center',fontsize=9,color=color)
        for spine in ax.spines.values():spine.set_visible(False)
        ax.set_xticks(np.arange(-.5,4,1),minor=True);ax.set_yticks(np.arange(-.5,len(effects),1),minor=True)
        ax.grid(which='minor',color='white',linewidth=2);ax.tick_params(which='minor',length=0)
    fig.suptitle('Which optional inputs help recognize entry and exit targets?',fontsize=17,x=.51,y=.98)
    fig.subplots_adjust(left=.15,right=.89,top=.85,bottom=.20,wspace=.13)
    colorax=fig.add_axes([.915,.23,.015,.58]);fig.colorbar(im,cax=colorax,label='AP percentage-point contribution')
    fig.text(.16,.065,'Cells: median across 3 seeds of the four-fold mean change in average precision (AP).\nBlue = better target ranking; red = worse. AP is not trading profit. News and costs excluded.\nLiquidity was unavailable in training; rare long targets and reused historical windows limit certainty.',fontsize=10,color='#444444')
    fig.savefig(HERE/'feature-effects.png',dpi=160,facecolor='white',bbox_inches='tight',pad_inches=.25)
    fig.savefig(HERE/'feature-effects.svg',facecolor='white',bbox_inches='tight',pad_inches=.25);plt.close(fig)
    print(json.dumps({'figure':str(HERE/'feature-effects.png'),'groups':len(effects),'roles':len(roles)}))
if __name__=='__main__':main()
